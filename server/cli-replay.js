/**
 * Seed the signal history by replaying past candles through the live logic.
 *   npm run replay
 */
import { config } from './config.js';
import { replayAll } from './replay.js';
import { runBacktests } from './tracker.js';

console.log(`\nИсточник: ${config.source}   ТФ: ${config.timeframe} (фильтр ${config.higherTimeframe})`);

// Probabilities lean on backtest outcomes, so build that evidence first —
// otherwise the earliest replayed signals would carry no estimate.
console.log('Считаю бэктест (нужен для оценки вероятностей)…');
await runBacktests();

console.log('Прогоняю историю через логику выдачи сигналов…\n');
const results = await replayAll();

console.log('Монета       Выдано  Закрыто  Осталось');
console.log('─'.repeat(44));
let created = 0;
let resolved = 0;
for (const r of results) {
  if (r.error) { console.log(`${r.symbol.padEnd(12)} ошибка: ${r.error}`); continue; }
  if (r.skipped) { console.log(`${r.symbol.padEnd(12)} пропуск: ${r.skipped}`); continue; }
  created += r.created; resolved += r.resolved;
  console.log(`${r.symbol.padEnd(12)} ${String(r.created).padStart(6)} ${String(r.resolved).padStart(8)} ${String(r.stillOpen).padStart(9)}`);
}
console.log('─'.repeat(44));
console.log(`${'ИТОГО'.padEnd(12)} ${String(created).padStart(6)} ${String(resolved).padStart(8)}`);

console.log('\nЭти сигналы помечены как «реплей»: они восстановлены по прошлым свечам,');
console.log('а не выданы в реальном времени, и в живой трек-рекорд не попадают.');
if (config.source === 'synthetic') {
  console.log('⚠ Данные синтетические — история относится к генератору, а не к рынку.');
}
console.log('');
process.exit(0);
