/**
 * Markdown health-and-validation report.
 *
 * Written for GitHub Actions: the output goes straight into the job summary,
 * so the whole check can be read on a phone without running anything locally.
 *
 *   node server/cli-report.js >> $GITHUB_STEP_SUMMARY
 *
 * Everything that can fail is reported rather than thrown, because a report
 * that dies halfway tells you less than one that says what broke.
 */
import { config } from './config.js';
import { checkSource, getCandles } from './sources/index.js';
import { activeHost } from './sources/binance.js';
import { auditCandles, describeAudit } from './dataQuality.js';
import { runBacktests } from './tracker.js';
import { runValidation } from './validate.js';

const out = [];
const say = (line = '') => out.push(line);

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : (v * 100).toFixed(1) + '%');
const num = (v, d = 2) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(d));
const dt = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

const VERDICT_ICON = {
  consistent: '✅', robust: '✅',
  mixed: '⚠️', unknown: '⚪',
  concentrated: '❌', fragile: '❌', weak: '❌',
};

say(`# CoinScope — проверка ${dt(Date.now())}`);
say();
say(`Источник: \`${config.source}\` · таймфрейм ${config.timeframe} (фильтр ${config.higherTimeframe}) · монет: ${config.symbols.length}`);
say();

/* ------------------------------ 1. Source ----------------------------- */
say('## 1. Связь с биржей');
say();
const health = await checkSource();
if (health.ok) {
  say(`✅ Источник отвечает. Получено свечей в пробном запросе: ${health.candles}.`);
  if (config.source === 'binance') say(`Отвечающий хост: \`${activeHost()}\``);
} else {
  say(`❌ **Источник не отвечает:** \`${health.error}\``);
  say();
  say('Дальнейшие разделы посчитать нельзя. Возможные причины: биржа блокирует IP');
  say('раннера, сеть закрыта политикой, или хост недоступен.');
  console.log(out.join('\n'));
  process.exit(1);
}
say();

/* --------------------------- 2. Data quality -------------------------- */
say('## 2. Качество данных');
say();
say('| Монета | Свечей | Пропуски | Дубли | Отставание | Итог |');
say('|---|---:|---:|---:|---:|---|');
let badData = 0;
for (const symbol of config.symbols) {
  try {
    const candles = await getCandles(symbol, config.timeframe, config.candleLimit);
    const a = auditCandles(candles, config.timeframe, { minBars: 205 });
    if (!a.ok) badData++;
    say(`| ${symbol} | ${a.bars} | ${a.missingBars} | ${a.duplicates} | ${a.staleBars.toFixed(1)} св. | ${a.ok ? '✅' : '❌ ' + describeAudit(a)} |`);
  } catch (err) {
    badData++;
    say(`| ${symbol} | — | — | — | — | ❌ ${err.message} |`);
  }
}
say();
say(badData
  ? `❌ Проблемы с данными по ${badData} монетам — по ним сигналы выдаваться не будут.`
  : '✅ Данные по всем монетам прошли проверку.');
say();

/* ----------------------------- 3. Backtest ---------------------------- */
say('## 3. Бэктест');
say();
const { perSymbol, portfolio } = await runBacktests();
say('| Монета | Сделок | Винрейт | Средний R | Profit factor | Сумма R | Просадка |');
say('|---|---:|---:|---:|---:|---:|---:|');
for (const r of perSymbol) {
  if (r.error) { say(`| ${r.symbol} | ошибка: ${r.error} | | | | | |`); continue; }
  const s = r.stats;
  const pf = s.profitFactor === Infinity ? '∞' : num(s.profitFactor);
  say(`| ${r.symbol} | ${s.trades} | ${pct(s.winRate)} | ${num(s.avgR)} | ${pf} | ${num(s.totalR, 1)} | −${num(s.maxDrawdownR, 1)} |`);
}
const pf = portfolio.profitFactor === Infinity ? '∞' : num(portfolio.profitFactor);
say(`| **Итого** | **${portfolio.trades}** | **${pct(portfolio.winRate)}** | **${num(portfolio.avgR)}** | **${pf}** | **${num(portfolio.totalR, 1)}** | **−${num(portfolio.maxDrawdownR, 1)}** |`);
say();
if (!portfolio.reliable) {
  say(`⚠️ Сделок меньше ${config.minSampleForStats} — статистика ничего не доказывает.`);
  say();
}

/* ---------------------------- 4. Validation --------------------------- */
say('## 4. Проверка на устойчивость');
say();
const report = await runValidation();

say('### Во времени');
say();
say('| Отрезок | Сделок | Винрейт | Сумма R |');
say('|---|---:|---:|---:|');
for (const seg of report.timeline) {
  const s = seg.stats;
  say(`| ${dt(seg.from).slice(0, 10)} → ${dt(seg.to).slice(0, 10)} | ${s.trades} | ${pct(s.winRate)} | ${num(s.totalR, 1)} |`);
}
say();
say(`${VERDICT_ICON[report.consistency.verdict] || '⚪'} ${report.consistency.text}`);
say();

say('### К параметрам');
say();
const usable = report.grid.filter((c) => c.trades >= 10);
const good = usable.filter((c) => c.totalR > 0);
say(`Прогнано наборов порогов: **${report.grid.length}**, пригодных к оценке ${usable.length}, прибыльных **${good.length}**.`);
say();
const sorted = [...usable].sort((a, b) => b.totalR - a.totalR);
say('| | score ≥ | стоп | риск:прибыль | Сделок | Винрейт | Сумма R |');
say('|---|---:|---:|---:|---:|---:|---:|');
for (const c of sorted.slice(0, 3)) {
  say(`| лучшие | ${c.minScore} | ${c.atrStopMult}·ATR | 1:${c.rewardRisk} | ${c.trades} | ${pct(c.winRate)} | ${num(c.totalR, 1)} |`);
}
for (const c of sorted.slice(-3).reverse()) {
  say(`| худшие | ${c.minScore} | ${c.atrStopMult}·ATR | 1:${c.rewardRisk} | ${c.trades} | ${pct(c.winRate)} | ${num(c.totalR, 1)} |`);
}
say();
say(`${VERDICT_ICON[report.robustness.verdict] || '⚪'} ${report.robustness.text}`);
say();
say('> Лучшая ячейка сетки — не рекомендация к настройке: выбирать максимум по той же');
say('> истории и есть подгонка. Смотреть надо на ширину прибыльной области.');
say();

/* ------------------------------- Notes -------------------------------- */
say('---');
say();
if (config.source === 'synthetic') {
  say('⚠️ **Данные синтетические.** Все цифры выше относятся к генератору, а не к рынку.');
} else {
  say('Цифры получены на реальных данных биржи. Это исторический прогон,');
  say('а не обещание будущей доходности.');
}
say();
say('Это не финансовая рекомендация.');

console.log(out.join('\n'));
process.exit(0);
