/**
 * Run the historical verification from the command line and print a table.
 *   npm run backtest
 *   COINSCOPE_SOURCE=binance npm run backtest
 */
import { config } from './config.js';
import { runBacktests } from './tracker.js';
import { COSTS } from './backtest.js';

const pct = (v) => (v == null ? '   —  ' : (v * 100).toFixed(1).padStart(5) + '%');
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '  —  ' : v.toFixed(d).padStart(6));

console.log(`\nИсточник: ${config.source}   ТФ: ${config.timeframe} (фильтр ${config.higherTimeframe})`);
console.log(`Комиссия: ${(COSTS.feeRate * 100).toFixed(3)}% за сторону, проскальзывание ${(COSTS.slippageRate * 100).toFixed(3)}%`);
console.log(`Порог сигнала: score >= ${config.strategy.minScore}, ADX >= ${config.strategy.minAdx}, RR = 1:${config.strategy.rewardRisk}\n`);

const { perSymbol, portfolio } = await runBacktests();

console.log('Монета      Сделок  Винрейт  Ср.R   PF     Сумма R  Просадка');
console.log('─'.repeat(66));
for (const r of perSymbol) {
  if (r.error) { console.log(`${r.symbol.padEnd(11)} ошибка: ${r.error}`); continue; }
  const s = r.stats;
  console.log(
    `${r.symbol.padEnd(11)} ${String(s.trades).padStart(5)}  ${pct(s.winRate)}  ${num(s.avgR)} ` +
    `${num(s.profitFactor)} ${num(s.totalR, 1)}   ${num(s.maxDrawdownR, 1)}` +
    (s.reliable ? '' : '  (мало сделок)')
  );
}
console.log('─'.repeat(66));
const p = portfolio;
console.log(
  `${'ИТОГО'.padEnd(11)} ${String(p.trades).padStart(5)}  ${pct(p.winRate)}  ${num(p.avgR)} ` +
  `${num(p.profitFactor)} ${num(p.totalR, 1)}   ${num(p.maxDrawdownR, 1)}`
);

if (!p.reliable) {
  console.log(`\n⚠ Меньше ${config.minSampleForStats} сделок — статистика ничего не доказывает.`);
}
if (config.source === 'synthetic') {
  console.log('\n⚠ Данные синтетические. Эти цифры про генератор, а не про рынок.');
}
console.log('');
process.exit(0);
