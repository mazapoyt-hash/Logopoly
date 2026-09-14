/**
 * Cross-sectional momentum run.
 *
 * A separate job because it asks a question none of the others ask. The scan
 * asks "is this coin worth buying". The deep run asks "did that question ever
 * have a good answer" — and the answer, across every measurement so far, is no:
 * the entries are indistinguishable from random, and what looked like an edge
 * before costs was the market's own drift.
 *
 * This asks something different and strictly relative: does ranking the coins
 * AGAINST EACH OTHER and holding the leaders beat simply holding all of them.
 * If it does not, the honest output is a run that says so, and that is a
 * perfectly good outcome for a job whose purpose is to find out.
 *
 * Like every other measurement job here it decides nothing and re-tunes
 * nothing. It writes data/cross.json for the site and a markdown summary for
 * the Actions run.
 */
import fs from 'node:fs';

import { config } from './config.js';
import { getHistory, checkSource, getUniverse } from './sources/index.js';
import { crossSectional, crossGrid, holdings, leaveOneOut } from './cross.js';
import { COSTS } from './backtest.js';
import {
  costsBySymbol as buildCosts, describeUniverse, slippageFor, MIN_VOLUME as FLOOR,
} from './liquidity.js';
import { screenByToll } from './economics.js';
import { DATA_DIR, writeJson } from './staticRun.js';

/**
 * Daily bars by default, and not arbitrarily. The toll — round-trip cost as a
 * share of the move being captured — is 0.135R on hourly bars and 0.022R on
 * daily. A rebalance every few bars is a cost decision before it is a signal
 * decision, so the cheap timeframe is where a weak effect has any chance of
 * surviving its own trading.
 */
const TIMEFRAME = process.env.COINSCOPE_CROSS_TIMEFRAME || '1d';
/*
 * Deliberately more than MIN_BARS below. Requesting exactly the minimum would
 * demand a coin have every single requested bar with nothing to spare, so one
 * missing day would disqualify it — the filter would then be about fetch luck
 * rather than about history.
 */
const BARS = Number(process.env.COINSCOPE_CROSS_BARS || 1600);
const UNIVERSE = Number(process.env.COINSCOPE_CROSS_UNIVERSE || 40);
const MIN_VOLUME = Number(process.env.COINSCOPE_MIN_VOLUME || FLOOR);
const MODE = process.env.COINSCOPE_CROSS_MODE || 'longOnly';
const HOLDOUT = Number(process.env.COINSCOPE_CROSS_HOLDOUT || 0.3);
const REPLICATES = Number(process.env.COINSCOPE_CROSS_REPLICATES || 400);

/**
 * Minimum history a coin needs to join the panel, and it buys years.
 *
 * A cross-section needs coins to share DATES, and a date only counts when most
 * of the universe has a bar for it. So the panel's start is dragged forward by
 * whichever coins listed most recently — one new listing costs everyone else
 * their earlier history.
 *
 * Measured on the first live run: the panel was 886 days, not because the
 * market is young but because UUSDT had 244 bars, PUMPUSDT 368, HOLOUSDT 368,
 * TRUMPUSDT 603. Meanwhile 22 of the 36 coins had more than 1200.
 *
 * That is a trade worth making, and it is the specific thing this measurement
 * lacked. The decomposition showed one coin carrying 93% of the edge — not
 * because the data was dirty but because 2.4 years contains about one big
 * momentum move, and one event is not evidence however good its percentile
 * looks. Fewer coins over more years is more independent events, which is the
 * only thing that can settle the question.
 */
const MIN_BARS = Number(process.env.COINSCOPE_CROSS_MIN_BARS || 1200);

const n1 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
const n2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');
const sign = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(1)}`);

const VERDICT = {
  edge: '🟢 ранжирование несёт информацию',
  weak: '🟡 на границе шума',
  none: '⚪ неотличимо от случайного выбора',
  'worse-than-holding': '🔴 хуже, чем просто держать всё',
};

async function main() {
  const health = await checkSource();
  if (!health.ok) {
    console.error(`Источник недоступен: ${health.error}`);
    process.exit(1);
  }

  let symbols = config.symbols;
  const universe = await getUniverse({ limit: UNIVERSE, minQuoteVolume: MIN_VOLUME });
  if (universe.length) symbols = universe.map((u) => u.symbol);
  console.log(`Вселенная: ${symbols.length} монет из ${UNIVERSE} запрошенных, ` +
    `оборот от $${(MIN_VOLUME / 1e6).toFixed(0)}M. Таймфрейм ${TIMEFRAME}, ${BARS} свечей, ` +
    `история от ${MIN_BARS} баров.`);

  /*
   * A cross-section of seven coins is not a cross-section, and the first live
   * run stopped here. Stopping was right, but the message blamed the idea when
   * the cause was upstream: the exchange request returned seven rows where
   * forty were asked for, and the scan had been running on that for days
   * without saying so. Name the real cause and where to look.
   */
  if (universe.length && universe.length < UNIVERSE / 2) {
    console.log(`  ⚠️ вселенная вернулась узкой (${universe.length} из ${UNIVERSE}). ` +
      'Это не свойство рынка: на споте Binance сотни пар проходят этот порог. ' +
      'Диагностика — Actions → «Диагностика вселенной».');
  }

  /*
   * A cross-section needs the coins to share dates, so a coin that fails to
   * load is dropped rather than fatal — alignCloses will discard the dates it
   * cannot cover anyway. A run on thirty-eight coins is still a run; a run that
   * aborts because one symbol 404'd is not.
   */
  /*
   * Costs per coin, from the turnover the exchange just reported.
   *
   * This is the half of the fix that makes the lower floor honest. A momentum
   * ranking systematically picks whatever moved most, which skews it towards
   * the thin end of the universe — so charging one average rate would subsidise
   * exactly the coins the strategy prefers, and the subsidy would surface as
   * edge.
   */
  const perSymbolCosts = buildCosts(universe);
  const liquidity = describeUniverse(universe, MIN_VOLUME);
  if (liquidity.kept) {
    console.log(`Издержки по монете: от ${(liquidity.medianSlippage * 100).toFixed(3)}% ` +
      `(медиана) до ${(liquidity.worstSlippage * 100).toFixed(3)}% за сторону; ` +
      `тоньше всех $${(liquidity.thinnest / 1e6).toFixed(0)}M в сутки.`);
  }

  const dataBySymbol = {};
  for (const symbol of symbols) {
    try {
      const candles = await getHistory(symbol, TIMEFRAME, BARS);
      if (candles.length >= MIN_BARS) dataBySymbol[symbol] = { candles };
      else {
        console.log(`  ${symbol}: ${candles.length} свечей < ${MIN_BARS} — ` +
          'пропускаю, иначе обрежет общее окно всем остальным');
      }
    } catch (err) {
      console.log(`  ${symbol}: ${err.message}`);
    }
  }
  /*
   * Disqualify by arithmetic, exactly as the deep run does — and the first live
   * decomposition is why this is here.
   *
   * That run's universe contained RLUSDUSDT, Ripple's dollar. A coin pegged to
   * a dollar barely moves, so round-trip costs swamp any move it makes, and the
   * project already paid for this lesson once: RLUSD produced −8.7R per trade
   * and dragged a whole portfolio from −0.12R to −0.41R.
   *
   * The name list cannot catch it — that is the recorded lesson, "имён
   * недостаточно, нужен механизм" — so the mechanism is the toll: costs as a
   * share of the coin's own typical move. The deep run has applied it for
   * months. The cross run never did, which is how a stablecoin ended up in a
   * momentum ranking carrying 16.7 п.п. of the reported edge.
   */
  const screen = screenByToll(dataBySymbol);
  for (const d of screen.dropped) {
    console.log(`  исключён ${d.symbol}: ${d.reason}` +
      (d.costR ? ` (ATR ${d.atrPct.toFixed(3)}%, пошлина ${d.costR.toFixed(2)}R)` : ` (${d.bars} свечей)`));
    delete dataBySymbol[d.symbol];
  }

  const loaded = Object.keys(dataBySymbol);
  console.log(`История загружена по ${loaded.length} монетам` +
    (screen.dropped.length ? ` (исключено по пошлине: ${screen.dropped.length}).` : '.'));
  if (loaded.length < 8) {
    console.error(`Для поперечного среза нужно минимум 8 монет, доступно ${loaded.length}. ` +
      'Ранжировать семь монет друг против друга бессмысленно: верхняя треть — ' +
      'это две монеты, и любой вердикт был бы шумом.');
    console.error('Причина почти наверняка выше по течению: биржа вернула ' +
      `${universe.length} монет вместо ${UNIVERSE}. Запустите «Диагностика вселенной» — ` +
      'она покажет, обрезается ответ или не проходит порог.');
    process.exit(1);
  }

  /* ------------------------------ measure ----------------------------- */
  console.log('Считаю сетку настроек и отложенную проверку…');
  const grid = crossGrid(dataBySymbol, {
    mode: MODE, costs: COSTS, replicates: Math.min(REPLICATES, 200), holdoutRatio: HOLDOUT,
    costsBySymbol: perSymbolCosts,
  });
  if (!grid) {
    console.error('Не удалось построить панель — нет общих дат у монет.');
    process.exit(1);
  }

  /*
   * The headline cell is the default setting, not the grid's winner. Quoting
   * the winner would be quoting the best of twenty-four draws and calling it a
   * measurement; the grid's own job is to show whether that winner is part of a
   * broad effect or a lone lucky cell.
   */
  const headline = crossSectional(dataBySymbol, {
    lookback: 40, hold: 10, topK: 5, mode: MODE, costs: COSTS, replicates: REPLICATES,
    costsBySymbol: perSymbolCosts,
  });

  /*
   * Who actually made the result — the check the first live run did not have.
   *
   * A cross-sectional edge has an obvious way to be fake: one coin that ran,
   * got picked every period, and carried everything while the percentile
   * happily agreed, because the control tests the ranking and not the breadth.
   * The funding report needed exactly this decomposition after one coin of
   * twenty-four produced its whole negative mean.
   */
  console.log('Проверяю, не сделала ли результат одна монета…');
  const concentration = leaveOneOut(dataBySymbol, {
    lookback: 40, hold: 10, topK: 5, mode: MODE, costs: COSTS,
    costsBySymbol: perSymbolCosts, replicates: 0,
  });
  const held = holdings(dataBySymbol, {
    lookback: 40, hold: 10, topK: 5, mode: MODE, costs: COSTS,
    costsBySymbol: perSymbolCosts,
  });

  const report = {
    generatedAt: Date.now(),
    source: config.source,
    timeframe: TIMEFRAME,
    mode: MODE,
    universe: {
      requested: UNIVERSE, loaded: loaded.length, minQuoteVolume: MIN_VOLUME,
      minBars: MIN_BARS,
      screened: screen.dropped,
    },
    costs: { feeRate: COSTS.feeRate, slippageRate: COSTS.slippageRate },
    liquidity,
    costsBySymbol: perSymbolCosts,
    headline,
    grid,
    concentration,
    held,
  };
  writeJson(DATA_DIR, 'cross.json', report);

  /* ------------------------------- report ----------------------------- */
  const out = [];
  out.push('## Поперечный срез: импульс монет друг против друга');
  out.push('');
  out.push(`Источник: ${config.source}, ${TIMEFRAME}, ${loaded.length} монет, ` +
    `${grid.cells.length ? headline.bars : '—'} общих дат ` +
    `(${day(headline?.strategy?.from)} — ${day(headline?.strategy?.to)}).`);
  out.push('');
  /*
   * A synthetic run produces the same tables as a real one, and those tables
   * get screenshotted. The generator builds coins with persistent per-symbol
   * drift, so it finds an effect by construction — which is useful for checking
   * that the machinery works and is evidence of precisely nothing about the
   * market. Say so at the top, not in a footnote.
   */
  if (config.source === 'synthetic') {
    out.push('> ⚠️ Это прогон на **сгенерированных** данных, а не на бирже. ' +
      'Генератор строит монеты с устойчивым собственным дрейфом, поэтому эффект ' +
      'здесь заложен в данные по построению. Числа ниже проверяют, что машинерия ' +
      'считает, и ничего не говорят о рынке.');
    out.push('');
  }
  out.push('Вопрос здесь другой, чем во всех остальных прогонах: не «стоит ли покупать ' +
    'эту монету», а «растёт ли она сильнее остальных». Ставка относительная, поэтому ' +
    'рыночный дрейф не может выдать себя за умение — и сравнивается она не с нулём, ' +
    'а с простым удержанием всех монет вселенной.');
  out.push('');

  if (headline) {
    out.push('### Базовая настройка (40/10/5)');
    out.push('');
    out.push(`**${VERDICT[headline.verdict] || headline.verdict}**`);
    out.push('');
    out.push('| | Годовых | Всего | Издержки | Оборот за период |');
    out.push('|---|---:|---:|---:|---:|');
    out.push(`| Ранжирование | **${n1(headline.strategy.annualPct)}%** | ` +
      `×${n2(headline.strategy.multiple)} | ${n1(headline.strategy.costPct)}% | ` +
      `${pct(headline.strategy.avgTurnover)} |`);
    if (headline.benchmark) {
      out.push(`| Держать всё поровну | ${n1(headline.benchmark.annualPct)}% | ` +
        `×${n2(headline.benchmark.multiple)} | ${n1(headline.benchmark.costPct)}% | ` +
        `${pct(headline.benchmark.avgTurnover)} |`);
    }
    out.push(`| Разница | **${sign(headline.excessAnnualPct)} п.п.** | | | |`);
    out.push('');
    out.push(`Против перемешанного контроля: **${n1(headline.nullPercentile)}-й процентиль** ` +
      `(медиана ${n1(headline.nullMedianAnnualPct)}%, 95-й ${n1(headline.nullP95AnnualPct)}%), ` +
      `${headline.params.replicates} повторов.`);
    out.push('');
    out.push('Контроль здесь — не «набрать монет наугад заново каждый период». Такой контроль ' +
      'перекладывается втрое чаще импульсного набора, поэтому его разброс уже, и стратегия ' +
      'попадает в его хвост чаще, чем этот хвост обещает: на заведомо пустых данных он ' +
      'объявлял находку в 2 случаях из 5. Здесь вместо этого **переставляются названия монет** — ' +
      'тот же самый набор, та же инерция, та же перекладка, но связь между прошлым монеты ' +
      'и её будущим разорвана. Ложных срабатываний на пустых данных: 1 из 40.');
    out.push('');
    out.push(headline.text);
    out.push('');
  }

  /*
   * What each coin was charged. A run that charged different coins different
   * costs has to show what it charged each one, or its totals are unauditable —
   * and this is the table where an implausibly cheap thin coin would be visible.
   */
  const charged = Object.entries(perSymbolCosts)
    .filter(([sym]) => loaded.includes(sym))
    .map(([sym, c]) => ({
      symbol: sym,
      quoteVolume: universe.find((u) => u.symbol === sym)?.quoteVolume ?? null,
      slip: c.slippageRate,
      trip: (c.feeRate + c.slippageRate) * 2,
    }))
    .sort((a, b) => b.trip - a.trip);

  if (charged.length) {
    out.push('### Что стоило торговать каждой монетой');
    out.push('');
    out.push('Порог вселенной опущен с $50M до $' + (MIN_VOLUME / 1e6).toFixed(0) + 'M, ' +
      'но не бесплатно: проскальзывание теперь считается по обороту как ' +
      '`0.05% × √($100M / оборот)`, а не плоской ставкой для всех. Опустить порог, ' +
      'не подняв издержки, означало бы впустить тонкие монеты по цене ликвидных — ' +
      'каждый результат стал бы лучше, и ни одно улучшение не было бы настоящим.');
    out.push('');
    out.push('| Монета | Оборот за сутки | Проскальзывание | Полный круг |');
    out.push('|---|---:|---:|---:|');
    for (const r of charged.slice(0, 12)) {
      out.push(`| ${r.symbol} | ${r.quoteVolume ? '$' + (r.quoteVolume / 1e6).toFixed(0) + 'M' : '—'} | ` +
        `${(r.slip * 100).toFixed(3)}% | ${(r.trip * 100).toFixed(3)}% |`);
    }
    if (charged.length > 12) out.push(`| …ещё ${charged.length - 12} | | | |`);
    out.push('');
    out.push('Для сравнения: старая плоская модель брала ' +
      `${(slippageFor(100e6) * 100).toFixed(3)}% со всех подряд.`);
    out.push('');
  }

  if (concentration) {
    out.push('### Не сделала ли результат одна монета');
    out.push('');
    out.push('Каждая строка — прогон на вселенной, где этой монеты **никогда не было**: ' +
      'ранжирование пересобирается, бенчмарк тоже. Это отвечает на вопрос ' +
      '«сработало бы без неё», а не на более лёгкий «сколько она внесла».');
    out.push('');
    out.push(`${concentration.dominated ? '🔴' : '🟢'} **${concentration.text}**`);
    out.push('');
    out.push('| Убрали | Разница без неё | Потеряно | Держалась |');
    out.push('|---|---:|---:|---:|');
    const heldShare = new Map((held?.rows || []).map((r) => [r.symbol, r.share]));
    for (const r of concentration.rows.slice(0, 10)) {
      const sh = heldShare.get(r.symbol);
      out.push(`| ${r.symbol} | ${sign(r.excessAnnualPct)} п.п. | ` +
        `${sign(-r.excessLost)} | ${sh == null ? '—' : (sh * 100).toFixed(0) + '%'} |`);
    }
    out.push('');
    if (held) {
      out.push(`Для сравнения: при идеально ровной ротации каждая монета держалась бы ` +
        `${(held.evenShare * 100).toFixed(0)}% периодов. Чаще всех — ` +
        `${(held.topShare * 100).toFixed(0)}%. Ни разу не попали в набор: ${held.neverHeld}.`);
      out.push('');
      out.push('Высокая доля удержания сама по себе не приговор: если у монеты ' +
        'действительно лучший импульс, правило право, что держит её. Приговор — ' +
        'строка выше, где без неё преимущество исчезает.');
      out.push('');
    }
  }

  out.push('### Сетка настроек');
  out.push('');
  out.push('| Оглядка | Держим | Монет | Годовых | Держать всё | Разница | Процентиль |');
  out.push('|---:|---:|---:|---:|---:|---:|---:|');
  for (const c of grid.cells) {
    out.push(`| ${c.lookback} | ${c.hold} | ${c.topK} | ${n1(c.annualPct)}% | ` +
      `${n1(c.benchmarkPct)}% | ${sign(c.excessAnnualPct)} | ${n1(c.nullPercentile)} |`);
  }
  out.push('');
  out.push(`Обыграли удержание всех монет: **${grid.beatingBenchmark} из ${grid.total}**. ` +
    `Обыграли ещё и контроль: **${grid.withEdge}**.`);
  out.push('');
  out.push(grid.text);
  out.push('');

  out.push('### Отложенная часть');
  out.push('');
  out.push(grid.holdoutText);
  out.push('');
  if (grid.holdout) {
    out.push(`Отложенный кусок: ${grid.holdout.strategy.periods} перекладок, ` +
      `${day(grid.holdout.strategy.from)} — ${day(grid.holdout.strategy.to)}, ` +
      `${n1(grid.holdout.strategy.annualPct)}% годовых против ` +
      `${n1(grid.holdout.benchmark?.annualPct)}% у удержания всех, ` +
      `${n1(grid.holdout.nullPercentile)}-й процентиль против контроля.`);
    out.push('');
  }
  out.push('Сетка настраивалась на первых ' + Math.round((1 - HOLDOUT) * 100) + '% истории, ' +
    'отложенный кусок — последние ' + Math.round(HOLDOUT * 100) + '%, и он не участвовал ' +
    'в выборе ячейки. Это единственное число в отчёте, которое не выбирали задним числом.');

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
