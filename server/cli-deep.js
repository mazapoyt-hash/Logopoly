/**
 * Deep analysis run.
 *
 * The scheduled scan works on 500 candles — enough to decide today's signals,
 * far too little to judge the strategy. Twenty days is one market regime, and
 * every bucket in a fine-grained breakdown would hold three trades.
 *
 * So this is a separate, slower job: page a long history off the exchange, run
 * the same strategy over it, and produce the diagnostic statistics. It writes
 * data/analytics.json for the site and a markdown summary for the Actions run.
 *
 * It deliberately does NOT change any threshold. Its output is evidence; what
 * to do about the evidence is a decision, and a decision that gets made by
 * reading a table, not by a script that quietly re-tunes itself into whatever
 * the last few months rewarded.
 */
import fs from 'node:fs';
import path from 'node:path';

import { config, timeframeMs } from './config.js';
import { getHistory, checkSource, referenceNow, getUniverse } from './sources/index.js';
import { backtestSymbol } from './backtest.js';
import { auditCandles, describeAudit } from './dataQuality.js';
import { analyse, reserveVault, evaluateOnVault, VAULT_RATIO } from './analytics.js';
import { tollByTimeframe, screenByToll } from './economics.js';
import { DATA_DIR, loadState, writeJson } from './staticRun.js';

const BARS = Number(process.env.COINSCOPE_HISTORY_BARS || 8000);
const RATIO = Number(process.env.COINSCOPE_HOLDOUT_RATIO || 0.7);
const OPEN_VAULT = process.env.COINSCOPE_OPEN_VAULT === '1';
const VAULT_LOG = 'vault.json';

const pct = (v) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`);
const r2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

async function main() {
  const health = await checkSource();
  if (!health.ok) {
    console.error(`Источник недоступен: ${health.error}`);
    process.exit(1);
  }

  const tfMs = timeframeMs(config.timeframe);
  const htfMs = timeframeMs(config.higherTimeframe);
  // The higher timeframe has to cover the same span plus its own EMA200 warm-up.
  const htfBars = Math.ceil((BARS * tfMs) / htfMs) + 300;

  /*
   * A wider universe multiplies the sample, which is the cheapest real
   * improvement available. Chosen by turnover, not by hand: see
   * config.universe.minQuoteVolume for why the floor is an honesty filter
   * rather than a quality one.
   */
  let symbols = config.symbols;
  let universe = null;
  if (config.universe.size > 0) {
    universe = await getUniverse({
      limit: config.universe.size, minQuoteVolume: config.universe.minQuoteVolume,
    });
    if (universe.length) symbols = universe.map((u) => u.symbol);
    console.log(`Вселенная: ${symbols.length} монет с оборотом от ` +
      `$${(config.universe.minQuoteVolume / 1e6).toFixed(0)}M за сутки.`);
  }

  console.log(`Источник: ${config.source}. Запрашиваю ${BARS} свечей ${config.timeframe} ` +
    `и ${htfBars} свечей ${config.higherTimeframe} по каждой из ${symbols.length} монет.`);

  const dataBySymbol = {};
  const quality = [];
  // Kept per timeframe for the cost-toll comparison: the same fee is a very
  // different share of risk depending on how wide an ATR-scaled stop is.
  const byTimeframe = { [config.timeframe]: {}, [config.higherTimeframe]: {}, '1d': {} };

  for (const symbol of symbols) {
    const candles = await getHistory(symbol, config.timeframe, BARS);
    const htf = await getHistory(symbol, config.higherTimeframe, htfBars);
    dataBySymbol[symbol] = { candles, htf };
    byTimeframe[config.timeframe][symbol] = candles;
    byTimeframe[config.higherTimeframe][symbol] = htf;
    try {
      byTimeframe['1d'][symbol] = await getHistory(symbol, '1d', 500);
    } catch { /* the daily series is only used for the comparison */ }

    const audit = auditCandles(candles, config.timeframe, {
      minBars: 300, now: referenceNow(config.timeframe),
    });
    quality.push({ symbol, bars: candles.length, ok: audit.ok, detail: describeAudit(audit) });
    console.log(`  ${symbol}: ${candles.length} свечей ` +
      `(${day(candles[0]?.time)} → ${day(candles[candles.length - 1]?.time)}), ` +
      `${audit.ok ? 'данные чистые' : describeAudit(audit)}`);
  }

  /*
   * Disqualify by arithmetic before anything else runs. A coin whose stop is
   * so tight that costs exceed half the risk per trade cannot be traded
   * profitably by any strategy — see screenByToll for the stablecoin that
   * taught this the expensive way.
   */
  const screen = screenByToll(dataBySymbol);
  for (const d of screen.dropped) {
    console.log(`  исключён ${d.symbol}: ${d.reason}` +
      (d.costR ? ` (ATR ${d.atrPct.toFixed(3)}%, пошлина ${r2(d.costR)}R)` : ` (${d.bars} свечей)`));
  }
  const screened = screen.kept;
  if (screen.dropped.length) {
    console.log(`Осталось монет: ${Object.keys(screened).length} из ${symbols.length}.`);
  }

  /*
   * The most recent slice is locked away before anything is computed, so no
   * part of the ordinary report — not the breakdowns, not the parameter
   * search, not the nulls — can see it. See reserveVault for why a plain
   * 70/30 split stops being a holdout after a few iterations.
   */
  const { working, vault } = reserveVault(screened);
  console.log(`\nПоследние ${Math.round(VAULT_RATIO * 100)}% истории убраны в сейф ` +
    'и в отчёте не участвуют.');

  const trades = [];
  for (const [symbol, { candles, htf }] of Object.entries(working)) {
    const res = backtestSymbol({ symbol, timeframe: config.timeframe, candles, htfCandles: htf });
    trades.push(...res.trades);
  }
  trades.sort((a, b) => a.entryTime - b.entryTime);
  console.log(`Сделок в рабочей части истории: ${trades.length}`);

  // The site's own published signals, for the calibration check.
  const state = loadState();
  const closedSignals = state.signals.filter((s) => s.status && s.status !== 'open');

  console.log(`Подбор параметров с проверкой на отложенной выборке (${Math.round(RATIO * 100)}/` +
    `${Math.round((1 - RATIO) * 100)})…`);
  const report = analyse({ trades, signals: closedSignals, dataBySymbol: working, ratio: RATIO });
  report.history = {
    requestedBars: BARS, timeframe: config.timeframe, quality, vaultRatio: VAULT_RATIO,
    symbols: Object.keys(screened).length,
    symbolsRequested: symbols.length,
    screened: screen.dropped,
    universe: universe && {
      size: universe.length, minQuoteVolume: config.universe.minQuoteVolume,
      coins: universe.map((u) => ({ symbol: u.symbol, quoteVolume: u.quoteVolume })),
    },
  };
  report.vault = openVaultIfAsked(vault);
  report.tollByTimeframe = tollByTimeframe(byTimeframe);
  report.screen = { maxTollR: screen.maxTollR, dropped: screen.dropped };

  writeJson(DATA_DIR, 'analytics.json', report);
  console.log(`\nЗаписано: ${path.join(DATA_DIR, 'analytics.json')}`);

  printSummary(report);
}

/**
 * Open the reserved slice, but only when explicitly asked, and never quietly.
 *
 * The log is kept in git and appended to, never rewritten: its whole purpose is
 * to make the opening count impossible to lose. A vault opened once is a fair
 * test of the current settings; opened repeatedly it is just a slower way of
 * fitting to the same data, and only the count reveals which of the two
 * happened.
 */
function openVaultIfAsked(vaultData) {
  const file = path.join(DATA_DIR, VAULT_LOG);
  let log = { openings: [] };
  try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* first time */ }
  if (!Array.isArray(log.openings)) log.openings = [];

  if (!OPEN_VAULT) {
    return {
      opened: false, timesOpenedBefore: log.openings.length,
      note: 'Сейф не открывался в этом прогоне. Открыть: COINSCOPE_OPEN_VAULT=1 — ' +
        'но каждое открытие снижает его ценность, и все они записаны.',
      history: log.openings,
    };
  }

  const result = evaluateOnVault(vaultData);
  const entry = {
    at: Date.now(), params: result.params,
    trades: result.stats.trades, avgR: result.stats.avgR,
    totalR: result.stats.totalR, winRate: result.stats.winRate,
    profitFactor: result.stats.profitFactor,
  };
  log.openings.push(entry);
  writeJson(DATA_DIR, VAULT_LOG, log);

  console.log(`\n⚠ Сейф открыт (раз №${log.openings.length}). ` +
    `Сделок ${entry.trades}, средний R ${r2(entry.avgR)}, сумма ${r2(entry.totalR)}R.`);
  if (log.openings.length > 1) {
    console.log('  Это не первое открытие — как честная проверка «на невиданных данных» ' +
      'сейф уже израсходован.');
  }

  return { opened: true, timesOpenedBefore: log.openings.length - 1, result: entry, history: log.openings };
}

/** Markdown for the GitHub job summary — the run has to be readable from a phone. */
function printSummary(rep) {
  const out = [];
  const o = rep.overall;
  out.push('# Глубокий анализ\n');
  out.push(`Период: **${day(rep.sample.from)} — ${day(rep.sample.to)}**, сделок: **${o.trades}**\n`);
  out.push('| Метрика | Значение |', '|---|---|');
  out.push(`| Винрейт | ${pct(o.winRate)} |`);
  out.push(`| Средний R | ${r2(o.avgR)} |`);
  out.push(`| Profit factor | ${r2(o.profitFactor)} |`);
  out.push(`| Сумма | ${r2(o.totalR)}R |`);
  out.push(`| Просадка | −${r2(o.maxDrawdownR)}R |\n`);

  // First, because everything below is meaningless if this one fails.
  if (rep.randomEntry) {
    const re = rep.randomEntry;
    out.push('## Против случайных входов\n');
    out.push(re.text + '\n');
    out.push('| | Средний R | Винрейт |', '|---|---:|---:|');
    out.push(`| Стратегия | ${r2(re.real.avgR)} | ${pct(re.real.winRate)} |`);
    out.push(`| Случайные входы (медиана) | ${r2(re.nullModel.p50)} | ${pct(re.nullModel.medianWinRate)} |`);
    out.push(`| Случайные входы (5–95%) | ${r2(re.nullModel.p05)} … ${r2(re.nullModel.p95)} | |\n`);
    out.push(`Процентиль стратегии среди ${re.replicates} случайных прогонов: ` +
      `**${(re.percentile * 100).toFixed(0)}**\n`);

    const g = rep.randomEntryGross;
    if (g) {
      out.push('### То же самое без издержек\n');
      out.push(`Процентиль: **${(g.percentile * 100).toFixed(0)}**. ` +
        `Стратегия ${r2(g.real.avgR)} против медианы случайных ${r2(g.nullModel.p50)}.\n`);
      out.push(g.percentile >= 0.95 && re.percentile < 0.95
        ? '**Сигнал есть, но он не окупает издержки.** Без комиссии входы обыгрывают случайные, ' +
          'с комиссией — нет. Лечится не порогами, а размером риска на сделку: издержки берутся ' +
          'от цены, поэтому съедают тем большую долю R, чем ближе стоп.\n'
        : g.percentile >= 0.95
          ? 'Входы обыгрывают случайные и с издержками, и без них.\n'
          : '**Дело не в издержках.** Даже при нулевых входы не лучше случайных — значит, ' +
            'плюс без издержек создан не выбором момента, а чем-то ещё (дрейфом рынка, ' +
            'геометрией стопа и цели).\n');
    }
  }

  if (rep.toll || rep.tollByTimeframe) {
    out.push('## Пошлина: что должна перебить любая идея\n');
    if (rep.toll) {
      out.push(`Медианный стоп — ${rep.toll.medianRiskPct.toFixed(2)}% от цены, круговые издержки ` +
        `${rep.toll.roundTripPct.toFixed(2)}%. Значит, каждая сделка стартует с ` +
        `**−${r2(rep.toll.costR)}R**, и это тот порог, который надо превзойти просто ради нуля.\n`);
    }
    if (rep.tollByTimeframe) {
      out.push(rep.tollByTimeframe.text + '\n');
      out.push('| Таймфрейм | Медианный ATR | Стоп | Пошлина |', '|---|---:|---:|---:|');
      for (const t of rep.tollByTimeframe.rows) {
        out.push(`| ${t.timeframe} | ${t.medianAtrPct.toFixed(2)}% | ${t.stopPct.toFixed(2)}% | ` +
          `−${r2(t.costR)}R |`);
      }
      out.push('');
    }
  }

  if (rep.money) {
    const m = rep.money;
    out.push(`## Что это значит в деньгах (ставка $${m.stake} на сигнал)\n`);
    out.push(m.text.replace(/\*\*/g, '**') + '\n');
    out.push('| Сигналов | Шанс быть в плюсе | Итог, если $' + m.stake +
      ' — позиция | Итог, если $' + m.stake + ' — риск |', '|---|---:|---:|---:|');
    for (const row of m.rows) {
      out.push(`| ${row.trades} | ${pct(row.probability)} | ` +
        `$${row.expected.position.toFixed(0)} | $${row.expected.risk.toFixed(0)} |`);
    }
    out.push('');
    if (m.goalText) out.push(m.goalText + '\n');
  }

  if (rep.screen?.dropped?.length) {
    out.push('## Исключённые монеты\n');
    out.push(`Порог: пошлина выше ${r2(rep.screen.maxTollR)}R на сделку — такую монету ` +
      'не спасёт никакая стратегия, поэтому она не участвует ни в одном числе ниже.\n');
    out.push('| Монета | Причина | ATR | Пошлина |', '|---|---|---:|---:|');
    for (const d of rep.screen.dropped) {
      out.push(`| ${d.symbol} | ${d.reason} | ${d.atrPct != null ? d.atrPct.toFixed(3) + '%' : '—'} | ` +
        `${d.costR != null ? r2(d.costR) + 'R' : '—'} |`);
    }
    out.push('');
  }

  if (rep.learning) {
    const l = rep.learning;
    out.push('## Помогает ли переобучение по ходу\n');
    out.push(l.text.replace(/\*\*/g, '**') + '\n');
    out.push('| Окно | Выбрал | Обещал | Дал | Без адаптации |',
      '|---|---|---:|---:|---:|');
    for (const s of l.steps) {
      const p = s.chose ? `score≥${s.chose.minScore}, ${s.chose.atrStopMult}×ATR, 1:${s.chose.rewardRisk}`
        : 'нечего выбирать';
      out.push(`| ${s.fold} | ${p} | ${r2(s.expectedAvgR)} | ${r2(s.adaptive.avgR)} | ` +
        `${r2(s.fixed.avgR)} |`);
    }
    out.push('');
  }

  if (rep.evidenceScale) {
    out.push('## Сколько сделок нужно, чтобы вообще увидеть край\n');
    out.push('| Размер края | Нужно сделок |', '|---|---:|');
    for (const e of rep.evidenceScale) out.push(`| ${e.edge}R | ${e.trades} |`);
    out.push('');
    out.push('_Разброс одной сделки около 1R. Отсюда n = (2 / край)². Система, которая ' +
      'учится после каждого сигнала, реагирует на одну тысячную той выборки, по которой ' +
      'вообще можно понять, было ли чему учиться._\n');
  }

  if (rep.winRateCurve) {
    const w = rep.winRateCurve;
    out.push('## Винрейт против денег\n');
    out.push(w.text + '\n');
    out.push('| Цель | Успешных | Нужно для нуля | Разрыв | Средний R |',
      '|---|---:|---:|---:|---:|');
    for (const row of w.rows) {
      out.push(`| ${row.target}R | ${pct(row.winRate)} | ${pct(row.requiredWinRate)}` +
        `${row.impossible ? ' ⛔' : ''} | ${(row.gap * 100).toFixed(1)} п.п. | ${r2(row.avgR)} |`);
    }
    out.push('');
    out.push(`_${w.note}_\n`);
  }

  if (rep.costs) {
    out.push('## Издержки\n');
    out.push(rep.costs.text + '\n');
    out.push('| Уровень | Средний R | Сумма R |', '|---|---:|---:|');
    for (const c of rep.costs.rows) out.push(`| ${c.label} | ${r2(c.avgR)} | ${r2(c.totalR)} |`);
    out.push('');
  }

  const mc = rep.multipleComparisons;
  out.push('## Множественные сравнения\n');
  out.push(`Проверено групп: **${mc.tested}**. Отличаются от остальных: **${mc.flagged}**.\n`);
  if (mc.measured) {
    out.push(`Измеренный уровень шума (${mc.measured.replicates} прогонов на данных, где связи ` +
      `нет по построению): медиана **${r2(mc.measured.median)}**, 95-й процентиль ` +
      `**${r2(mc.measured.p95)}**, максимум ${r2(mc.measured.max)}. ` +
      (mc.measured.clears
        ? `Найдено ${mc.flagged} — выше измеренного потолка шума. Есть что смотреть.`
        : `Найдено ${mc.flagged} — не выше того, что даёт шум. Находок нет.`) + '\n');
    out.push(`_Арифметическая оценка дала бы ${mc.expected.toFixed(1)}; измеренная выше, ` +
      'потому что сделки не независимы. Верить надо измеренной._\n');
  }

  const ctl = rep.breakdowns.find((b) => b.key === 'weekday');
  if (ctl?.tested) {
    const rest = rep.breakdowns.filter((b) => b.key !== 'weekday');
    const rt = rest.reduce((s, b) => s + b.tested, 0);
    const rf = rest.reduce((s, b) => s + b.flagged, 0);
    const ctlRate = ctl.flagged / ctl.tested;
    const restRate = rt ? rf / rt : 0;
    out.push(`**Контроль — день недели.** Связи там быть не может, поэтому его доля пометок — ` +
      `уровень шума. Контроль: ${ctl.flagged}/${ctl.tested} (${pct(ctlRate)}). ` +
      `Остальные: ${rf}/${rt} (${pct(restRate)}). ` +
      (restRate > ctlRate * 1.5
        ? 'Осмысленные разрезы помечаются заметно чаще — есть что изучать.\n'
        : 'Осмысленные разрезы помечаются не чаще бессмысленного — находок нет.\n'));
  }

  for (const b of rep.breakdowns) {
    out.push(`## ${b.label}\n`);
    out.push(`_${b.question}_\n`);
    out.push('| Группа | Сделок | Винрейт | Средний R (95% ДИ) | Против остальных | Сумма R |',
      '|---|---:|---:|---:|---:|---:|');
    for (const x of b.buckets) {
      const ci = x.avgLow == null ? '—' : `${r2(x.avgR)} (${r2(x.avgLow)} … ${r2(x.avgHigh)})`;
      out.push(`| ${x.key}${x.significant ? ' ⚑' : ''} | ${x.trades} | ${pct(x.winRate)} | ${ci} | ` +
        `${r2(x.vsRest)} | ${r2(x.totalR)} |`);
    }
    out.push('');
  }

  if (rep.excursions) {
    const e = rep.excursions;
    out.push('## Как далеко ходила цена\n');
    out.push(`Медианный максимум в нашу сторону: **${r2(e.medianMfeR)}R**, ` +
      `у убыточных сделок — **${r2(e.medianLoserMfeR)}R** (цель стоит на ${r2(e.currentTargetR)}R).\n`);
    out.push('| Дошла до | Все сделки | Из них убыточные |', '|---|---:|---:|');
    for (const l of e.reach) out.push(`| +${l.level}R | ${pct(l.all)} | ${pct(l.losers)} |`);
    out.push('');
  }

  if (rep.tuning) {
    out.push('## Подбор параметров на отложенной выборке\n');
    out.push(rep.tuning.text + '\n');
    if (rep.tuning.best) {
      const b = rep.tuning.best;
      out.push('| | Обучающая | Проверочная |', '|---|---:|---:|');
      out.push(`| Сделок | ${b.inSample?.trades ?? '—'} | ${b.outOfSample?.trades ?? '—'} |`);
      out.push(`| Средний R | ${r2(b.inSample?.avgR)} | ${r2(b.outOfSample?.avgR)} |`);
      out.push(`| Сумма R | ${r2(b.inSample?.totalR)} | ${r2(b.outOfSample?.totalR)} |\n`);
    }
  }

  if (rep.vault) {
    out.push('## Сейф\n');
    if (rep.vault.opened) {
      const v = rep.vault.result;
      out.push(`Открыт (раз №${rep.vault.timesOpenedBefore + 1}). Сделок ${v.trades}, ` +
        `средний R **${r2(v.avgR)}**, сумма **${r2(v.totalR)}R**, винрейт ${pct(v.winRate)}.\n`);
      if (rep.vault.timesOpenedBefore > 0) {
        out.push('Открывается не впервые — как честная проверка «на невиданных данных» ' +
          'сейф уже израсходован.\n');
      }
    } else {
      out.push(`Закрыт. Открывался раньше: ${rep.vault.timesOpenedBefore} раз(а). ` +
        'Последние 20% истории не участвуют ни в одном числе выше.\n');
    }
  }

  const text = out.join('\n');
  console.log('\n' + text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
}

main().catch((err) => {
  console.error(err.stack || err.message);
  process.exit(1);
});
