/**
 * Validate the strategy: consistency across time and robustness to parameters.
 *   npm run validate
 */
import { config } from './config.js';
import { runValidation } from './validate.js';
import { Reports } from './db.js';
import { writeJson, DATA_DIR } from './staticRun.js';

const pct = (v) => (v == null ? '  —  ' : (v * 100).toFixed(1).padStart(5) + '%');
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '  —  ' : v.toFixed(d).padStart(6));
const date = (ts) => new Date(ts).toLocaleDateString('ru-RU', { day: '2-digit', month: 'short' });

console.log(`\nИсточник: ${config.source}   ТФ: ${config.timeframe}   монет: ${config.symbols.length}`);
process.stdout.write('Считаю сетку параметров… ');
const report = await runValidation({
  onProgress: (i, total) => {
    if (i === total) process.stdout.write(`готово (${total} наборов)\n\n`);
  },
});
Reports.set('validation', report);
// The static site reads this file directly; the weekly workflow commits it.
writeJson(DATA_DIR, 'validation.json', report);

console.log('БАЗОВЫЙ ПРОГОН (текущие настройки)');
const b = report.baseline;
console.log(`  сделок ${b.trades}, винрейт ${pct(b.winRate)}, средний R ${num(b.avgR)}, сумма ${num(b.totalR, 1)}R\n`);

console.log('УСТОЙЧИВОСТЬ ВО ВРЕМЕНИ');
console.log('  Отрезок              Сделок  Винрейт   Сумма R');
for (const seg of report.timeline) {
  const s = seg.stats;
  console.log(`  ${date(seg.from)} – ${date(seg.to)}  ${String(s.trades).padStart(5)}  ${pct(s.winRate)}  ${num(s.totalR, 1)}`);
}
console.log(`  → ${report.consistency.text}\n`);

console.log('УСТОЙЧИВОСТЬ К ПАРАМЕТРАМ');
const profitable = report.grid.filter((c) => c.trades >= 10 && c.totalR > 0).length;
const usable = report.grid.filter((c) => c.trades >= 10).length;
console.log(`  прибыльных наборов: ${profitable} из ${usable} (всего в сетке ${report.grid.length})`);
const sorted = [...report.grid].filter((c) => c.trades >= 10).sort((a, b2) => b2.totalR - a.totalR);
console.log('  лучшие:');
for (const c of sorted.slice(0, 3)) {
  console.log(`    score>=${c.minScore} stop=${c.atrStopMult}ATR rr=1:${c.rewardRisk} → ${num(c.totalR, 1)}R, винрейт ${pct(c.winRate)}, сделок ${c.trades}`);
}
console.log('  худшие:');
for (const c of sorted.slice(-3).reverse()) {
  console.log(`    score>=${c.minScore} stop=${c.atrStopMult}ATR rr=1:${c.rewardRisk} → ${num(c.totalR, 1)}R, винрейт ${pct(c.winRate)}, сделок ${c.trades}`);
}
console.log(`  → ${report.robustness.text}\n`);

console.log('Лучшая ячейка сетки — не рекомендация к настройке: выбирать максимум по этой же');
console.log('истории и есть подгонка. Смотреть надо на ширину прибыльной области.');
if (config.source === 'synthetic') {
  console.log('\n⚠ Данные синтетические — выводы относятся к генератору, а не к рынку.');
}
console.log('');
process.exit(0);
