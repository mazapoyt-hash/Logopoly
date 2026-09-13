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
import { crossSectional, crossGrid } from './cross.js';
import { COSTS } from './backtest.js';
import { DATA_DIR, writeJson } from './staticRun.js';

/**
 * Daily bars by default, and not arbitrarily. The toll — round-trip cost as a
 * share of the move being captured — is 0.135R on hourly bars and 0.022R on
 * daily. A rebalance every few bars is a cost decision before it is a signal
 * decision, so the cheap timeframe is where a weak effect has any chance of
 * surviving its own trading.
 */
const TIMEFRAME = process.env.COINSCOPE_CROSS_TIMEFRAME || '1d';
const BARS = Number(process.env.COINSCOPE_CROSS_BARS || 1200);
const UNIVERSE = Number(process.env.COINSCOPE_CROSS_UNIVERSE || 40);
const MIN_VOLUME = Number(process.env.COINSCOPE_MIN_VOLUME || 50e6);
const MODE = process.env.COINSCOPE_CROSS_MODE || 'longOnly';
const HOLDOUT = Number(process.env.COINSCOPE_CROSS_HOLDOUT || 0.3);
const REPLICATES = Number(process.env.COINSCOPE_CROSS_REPLICATES || 400);

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
  console.log(`Вселенная: ${symbols.length} монет с оборотом от ` +
    `$${(MIN_VOLUME / 1e6).toFixed(0)}M. Таймфрейм ${TIMEFRAME}, ${BARS} свечей.`);

  /*
   * A cross-section needs the coins to share dates, so a coin that fails to
   * load is dropped rather than fatal — alignCloses will discard the dates it
   * cannot cover anyway. A run on thirty-eight coins is still a run; a run that
   * aborts because one symbol 404'd is not.
   */
  const dataBySymbol = {};
  for (const symbol of symbols) {
    try {
      const candles = await getHistory(symbol, TIMEFRAME, BARS);
      if (candles.length >= 200) dataBySymbol[symbol] = { candles };
      else console.log(`  ${symbol}: всего ${candles.length} свечей — мало, пропускаю`);
    } catch (err) {
      console.log(`  ${symbol}: ${err.message}`);
    }
  }
  const loaded = Object.keys(dataBySymbol);
  console.log(`История загружена по ${loaded.length} монетам.`);
  if (loaded.length < 8) {
    console.error('Слишком узкая вселенная для поперечного среза — прекращаю.');
    process.exit(1);
  }

  /* ------------------------------ measure ----------------------------- */
  console.log('Считаю сетку настроек и отложенную проверку…');
  const grid = crossGrid(dataBySymbol, {
    mode: MODE, costs: COSTS, replicates: Math.min(REPLICATES, 200), holdoutRatio: HOLDOUT,
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
  });

  const report = {
    generatedAt: Date.now(),
    source: config.source,
    timeframe: TIMEFRAME,
    mode: MODE,
    universe: { requested: UNIVERSE, loaded: loaded.length, minQuoteVolume: MIN_VOLUME },
    costs: { feeRate: COSTS.feeRate, slippageRate: COSTS.slippageRate },
    headline,
    grid,
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
