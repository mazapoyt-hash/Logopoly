/**
 * One scan cycle for the static site. Run by GitHub Actions on a schedule;
 * writes JSON into data/ which the Pages site reads.
 *
 *   node server/cli-scan.js
 */
import { config } from './config.js';
import { runStatic, DATA_DIR } from './staticRun.js';

console.log(`Источник: ${config.source} · ТФ ${config.timeframe} · монет ${config.symbols.length}`);

try {
  const { created, resolved, log, quality } = await runStatic();
  const bad = quality.filter((q) => !q.ok);

  console.log(`Новых сигналов: ${created}, закрыто: ${resolved}`);
  if (bad.length) {
    console.log(`Пропущено по качеству данных: ${bad.map((q) => `${q.symbol} (${q.detail})`).join(', ')}`);
  }
  for (const line of log) console.log('  ' + line);
  console.log(`Данные записаны в ${DATA_DIR}`);
  process.exit(0);
} catch (err) {
  console.error(`Прогон не удался: ${err.message}`);
  process.exit(1);
}
