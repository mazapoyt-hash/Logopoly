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
import { getHistory, checkSource, referenceNow } from './sources/index.js';
import { backtestSymbol } from './backtest.js';
import { auditCandles, describeAudit } from './dataQuality.js';
import { analyse } from './analytics.js';
import { DATA_DIR, loadState, writeJson } from './staticRun.js';

const BARS = Number(process.env.COINSCOPE_HISTORY_BARS || 8000);
const RATIO = Number(process.env.COINSCOPE_HOLDOUT_RATIO || 0.7);

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

  console.log(`Источник: ${config.source}. Запрашиваю ${BARS} свечей ${config.timeframe} ` +
    `и ${htfBars} свечей ${config.higherTimeframe} по каждой из ${config.symbols.length} монет.`);

  const dataBySymbol = {};
  const quality = [];
  for (const symbol of config.symbols) {
    const candles = await getHistory(symbol, config.timeframe, BARS);
    const htf = await getHistory(symbol, config.higherTimeframe, htfBars);
    dataBySymbol[symbol] = { candles, htf };

    const audit = auditCandles(candles, config.timeframe, {
      minBars: 300, now: referenceNow(config.timeframe),
    });
    quality.push({ symbol, bars: candles.length, ok: audit.ok, detail: describeAudit(audit) });
    console.log(`  ${symbol}: ${candles.length} свечей ` +
      `(${day(candles[0]?.time)} → ${day(candles[candles.length - 1]?.time)}), ` +
      `${audit.ok ? 'данные чистые' : describeAudit(audit)}`);
  }

  // The full-history backtest that everything else is computed from.
  const trades = [];
  for (const [symbol, { candles, htf }] of Object.entries(dataBySymbol)) {
    const res = backtestSymbol({ symbol, timeframe: config.timeframe, candles, htfCandles: htf });
    trades.push(...res.trades);
  }
  trades.sort((a, b) => a.entryTime - b.entryTime);
  console.log(`\nСделок в истории: ${trades.length}`);

  // The site's own published signals, for the calibration check.
  const state = loadState();
  const closedSignals = state.signals.filter((s) => s.status && s.status !== 'open');

  console.log(`Подбор параметров с проверкой на отложенной выборке (${Math.round(RATIO * 100)}/` +
    `${Math.round((1 - RATIO) * 100)})…`);
  const report = analyse({ trades, signals: closedSignals, dataBySymbol, ratio: RATIO });
  report.history = { requested: BARS, timeframe: config.timeframe, quality };

  writeJson(DATA_DIR, 'analytics.json', report);
  console.log(`\nЗаписано: ${path.join(DATA_DIR, 'analytics.json')}`);

  printSummary(report);
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

  const mc = rep.multipleComparisons;
  out.push('## Множественные сравнения\n');
  out.push(`Проверено групп: **${mc.tested}**. Значимых: **${mc.flagged}**. ` +
    `Случайность дала бы примерно **${mc.expected.toFixed(1)}**. ` +
    (mc.surplus > 1
      ? `Превышение на ${mc.surplus.toFixed(1)} — есть что смотреть.`
      : 'Превышения нет: всё найденное объясняется случайностью.') + '\n');

  for (const b of rep.breakdowns) {
    out.push(`## ${b.label}\n`);
    out.push(`_${b.question}_\n`);
    out.push('| Группа | Сделок | Винрейт | Средний R (95% ДИ) | Сумма R |', '|---|---:|---:|---:|---:|');
    for (const x of b.buckets) {
      const ci = x.avgLow == null ? '—' : `${r2(x.avgR)} (${r2(x.avgLow)} … ${r2(x.avgHigh)})`;
      out.push(`| ${x.key}${x.significant ? ' ⚑' : ''} | ${x.trades} | ${pct(x.winRate)} | ${ci} | ${r2(x.totalR)} |`);
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
