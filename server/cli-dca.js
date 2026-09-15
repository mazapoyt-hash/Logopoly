/**
 * Знаменатель: что даёт тот же план без всякой стратегии.
 *
 * Пять направлений измерены и закрыты, каждое — против случайных входов. Но
 * случайный вход не альтернатива: человек с деньгами выбирает не между
 * стратегией и монеткой, а между стратегией и «занести те же $100 и держать».
 * Это сравнение здесь не делалось ни разу.
 *
 * Прогон ничего не советует и не считает усреднение хорошей идеей. Он даёт
 * распределение по ВСЕМ датам старта, потому что один сценарий — это история
 * про одну дату, а начинающий не знает, в какую точку истории он попал.
 */
import fs from 'node:fs';

import { config } from './config.js';
import { getHistory, checkSource, getUniverse } from './sources/index.js';
import { COSTS } from './backtest.js';
import {
  startDistribution, basketCandles, yearsToIncome, describeDca,
} from './dca.js';
import { DATA_DIR, writeJson } from './staticRun.js';

const MONTHLY = Number(process.env.COINSCOPE_DCA_MONTHLY || 100);
/*
 * Дневные бары, а не часовые из config.timeframe. Вопрос здесь — про годы:
 * 8000 часовых свечей это 11 месяцев, из которых при горизонте в полгода
 * остаётся пять дат старта, и «распределение» по пяти точкам — это не
 * распределение. 2000 дневных покрывают 5.5 лет.
 */
const TIMEFRAME = process.env.COINSCOPE_DCA_TIMEFRAME || '1d';
const BARS = Number(process.env.COINSCOPE_DCA_BARS || 2000);
const UNIVERSE = Number(process.env.COINSCOPE_DCA_UNIVERSE || 20);
const MIN_YEARS = Number(process.env.COINSCOPE_DCA_MIN_YEARS || 1);
const INCOME = Number(process.env.COINSCOPE_DCA_INCOME || 50000);

const n2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
const pc = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`);

async function main() {
  const health = await checkSource();
  if (!health.ok) {
    console.error(`Источник недоступен: ${health.error}`);
    process.exit(1);
  }

  // Издержки на взнос — одна сторона, а не круг: взнос покупает и держит.
  const costRate = COSTS.feeRate + COSTS.slippageRate;
  console.log(`Взнос: $${MONTHLY}/мес, издержки на покупку ${(costRate * 100).toFixed(2)}%`);

  const universe = await getUniverse({
    limit: UNIVERSE, minQuoteVolume: config.universe.minQuoteVolume,
  });
  const symbols = universe.map((u) => u.symbol);
  console.log(`Вселенная: ${symbols.length} монет\n`);

  const bySymbol = {};
  for (const symbol of symbols) {
    try {
      const candles = await getHistory(symbol, TIMEFRAME, BARS);
      if (candles?.length) bySymbol[symbol] = candles;
    } catch (err) {
      console.log(`  ${symbol}: ${err.message}`);
    }
  }
  if (!Object.keys(bySymbol).length) {
    console.error('Данных не собралось.');
    process.exit(1);
  }

  const assets = {};
  for (const [symbol, candles] of Object.entries(bySymbol)) {
    const d = startDistribution(candles, { monthly: MONTHLY, costRate, minYears: MIN_YEARS });
    if (d) assets[symbol] = d;
  }
  const basket = basketCandles(bySymbol);
  const basketDist = basket.length
    ? startDistribution(basket, { monthly: MONTHLY, costRate, minYears: MIN_YEARS })
    : null;

  const report = {
    generatedAt: Date.now(),
    monthly: MONTHLY, costRate, bars: BARS, minYears: MIN_YEARS, incomeTarget: INCOME,
    timeframe: TIMEFRAME,
    assets: Object.fromEntries(Object.entries(assets).map(([s, d]) => [s, strip(d)])),
    basket: basketDist ? strip(basketDist) : null,
    basketSymbols: Object.keys(bySymbol),
  };

  // Цель при измеренных ставках корзины, а не при выдуманных.
  if (basketDist) {
    report.goal = {};
    for (const key of ['worst', 'median', 'best']) {
      report.goal[key] = yearsToIncome({
        monthly: MONTHLY, annualPct: basketDist.annualPct[key], incomePerYear: INCOME,
      });
    }
  }

  writeJson(DATA_DIR, 'dca.json', report);
  console.log(`Записано: ${DATA_DIR}/dca.json\n`);
  printSummary(report, assets, basketDist);
}

/** Без списка всех сценариев: он большой и в отчёте не читается. */
const strip = (d) => ({ ...d, runs: undefined });

function printSummary(rep, assets, basket) {
  const out = [];
  out.push('# Знаменатель: $100 в месяц без всякой стратегии\n');
  out.push(`Взнос **$${rep.monthly}/мес**, издержки ${(rep.costRate * 100).toFixed(2)}% с каждой ` +
    `покупки, таймфрейм ${rep.timeframe}, горизонт сценария от ${rep.minYears} года.\n`);

  out.push('## Почему распределение, а не одно число\n');
  out.push('Один прогон усреднения — это история про **одну дату старта**. ' +
    'Начав в одной точке, вы купили вершину; в другой — дно, и разница между ' +
    'этими двумя числами больше, чем разница между любыми двумя стратегиями, ' +
    'которые мы мерили. Поэтому считаются все возможные даты старта.\n');
  out.push('**Читать надо столбец «худший».** Начинающий не знает, в какую точку ' +
    'истории он попал, и медиана — это то, что он узнает только задним числом.\n');

  if (basket) {
    out.push('## Равновзвешенная корзина\n');
    out.push(describeDca(basket, { label: `Корзина из ${rep.basketSymbols.length} монет` }) + '\n');
    out.push('| | Худший | 25% | Медиана | 75% | Лучший |', '|---|---:|---:|---:|---:|---:|');
    const m = basket.multiple;
    const a = basket.annualPct;
    out.push(`| Во сколько раз | ×${n2(m.worst)} | ×${n2(m.p25)} | **×${n2(m.median)}** | ×${n2(m.p75)} | ×${n2(m.best)} |`);
    out.push(`| Годовых | ${n2(a.worst)}% | ${n2(a.p25)}% | **${n2(a.median)}%** | ${n2(a.p75)}% | ${n2(a.best)}% |`);
    out.push('');
    out.push(`Доля стартов, остающихся в минусе: **${pc(basket.lossRate)}**\n`);
  }

  out.push('## По монетам\n');
  out.push('| Монета | Сценариев | Худший | Медиана | Лучший | Годовых (медиана) | В минусе |',
    '|---|---:|---:|---:|---:|---:|---:|');
  const rows = Object.entries(assets)
    .sort((x, y) => y[1].multiple.median - x[1].multiple.median);
  for (const [symbol, d] of rows) {
    out.push(`| ${symbol} | ${d.scenarios} | ×${n2(d.multiple.worst)} | ` +
      `**×${n2(d.multiple.median)}** | ×${n2(d.multiple.best)} | ` +
      `${n2(d.annualPct.median)}% | ${pc(d.lossRate)} |`);
  }
  out.push('');

  if (rep.goal) {
    out.push(`## Цель: $${rep.incomeTarget.toLocaleString('en-US')} годового дохода\n`);
    out.push('| Сценарий | Годовых | Нужен капитал | Лет до цели |', '|---|---:|---:|---:|');
    const names = { worst: 'Худший старт', median: 'Медианный', best: 'Лучший' };
    for (const key of ['worst', 'median', 'best']) {
      const g = rep.goal[key];
      const a = rep.basket.annualPct[key];
      out.push(`| ${names[key]} | ${n2(a)}% | ` +
        `${g?.reachable ? '$' + Math.round(g.capitalNeeded).toLocaleString('en-US') : '—'} | ` +
        `${g?.reachable ? n2(g.years) : '**недостижима**'} |`);
    }
    out.push('');
    out.push('При неположительной ставке цель недостижима никаким временем: у капитала ' +
      'появляется потолок, выше которого взносы не поднимают.\n');
  }

  const text = out.join('\n');
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
