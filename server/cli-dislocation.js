/**
 * Прогон по расхождениям спот/перп.
 *
 * Отдельная работа от всех предыдущих, потому что задаёт вопрос другого класса.
 * Скан, глубокий анализ и поперечный срез спрашивают «куда пойдёт цена» — и все
 * три ответили «мы не знаем», каждый своим способом. Здесь ничего угадывать не
 * надо: перп и спот — один и тот же актив, связанный механизмом фандинга, и
 * вопрос только в том, расходятся ли они когда-нибудь настолько, чтобы окупить
 * двойное пересечение спреда, и за сколько баров сходятся обратно.
 *
 * Обе ноги берутся с ОДНОЙ площадки. Спот с Binance против шорта на OKX — это
 * тоже работающая сделка, но её «базис» будет спредом между двумя биржами, то
 * есть другой и более широкой величиной; смешивать их в одной таблице значит
 * мерить два разных объекта одним числом.
 *
 * Прогон ничего не решает. Он выдаёт свидетельство; что с ним делать — решение,
 * которое принимают, читая таблицу.
 */
import fs from 'node:fs';

import * as funding from './sources/funding.js';
import { getHistory } from './sources/index.js';
import { pairRoundTrip } from './funding.js';
import { dislocation, HORIZON, ENTRIES } from './dislocation.js';
import { DATA_DIR, writeJson } from './staticRun.js';

const UNIVERSE = Number(process.env.COINSCOPE_DISLOC_UNIVERSE || 25);
const MIN_VOLUME = Number(process.env.COINSCOPE_MIN_VOLUME || 10e6);
const BARS = Number(process.env.COINSCOPE_DISLOC_BARS || 1500);
const REPLICATES = Number(process.env.COINSCOPE_DISLOC_REPLICATES || 200);
const MIN_EPISODES = Number(process.env.COINSCOPE_DISLOC_MIN_EPISODES || 30);

const n2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
const n3 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(3));
const pc = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(1)}%`);

async function main() {
  let universe;
  try {
    universe = await funding.getPerpUniverse({ limit: UNIVERSE, minQuoteVolume: MIN_VOLUME });
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  const label = funding.sourceLabel();
  console.log(`Источник: ${label}`);

  const symbols = universe.map((u) => u.symbol);
  if (!symbols.length) {
    console.error('Вселенная перпетуалов пуста — нечего измерять.');
    console.error(funding.describeAttempts());
    process.exit(1);
  }
  console.log(`Перпетуалов: ${symbols.length} (${symbols.slice(0, 6).join(', ')}…)`);

  const trip = pairRoundTrip();
  console.log(`Круговые издержки на обе ноги: ${(trip * 100).toFixed(3)}%`);
  console.log(`Пороги входа: ${ENTRIES.map((e) => `${e}×`).join(', ')} от пошлины, ` +
    `горизонт ${HORIZON} баров\n`);

  const perSymbol = [];
  for (const symbol of symbols) {
    try {
      const perp = await funding.getPerpKlines(symbol, '1h', BARS);
      /*
       * Спот той же площадки — предпочтительно. Падать на Binance приходится
       * редко, но когда приходится, это надо записать: базис против чужого
       * спота шире по построению, и строка с таким флагом читается иначе.
       */
      const sameVenue = await funding.getVenueSpotKlines(symbol, '1h', BARS);
      const sameVenueOk = Boolean(sameVenue?.length);
      const spot = sameVenueOk ? sameVenue : await getHistory(symbol, '1h', BARS);

      const rep = dislocation(spot, perp, {
        trip, replicates: REPLICATES, minEpisodes: MIN_EPISODES,
      });
      if (!rep) {
        console.log(`  ${symbol}: данных не хватило`);
        continue;
      }
      perSymbol.push({ symbol, sameVenue: sameVenueOk, ...rep });
      console.log(`  ${symbol}: ${rep.verdict}` +
        (rep.best ? `, лучший порог ${n2(rep.best.enterPct)}% → ${n2(rep.best.annualPct)}% годовых ` +
          `на ${rep.best.count} эпизодах` : '') +
        (sameVenueOk ? '' : '  [спот с другой площадки]'));
    } catch (err) {
      console.log(`  ${symbol}: ${err.message}`);
    }
  }

  if (!perSymbol.length) {
    console.error('Ни по одной монете не собралось данных.');
    process.exit(1);
  }

  const counts = {};
  for (const r of perSymbol) counts[r.verdict] = (counts[r.verdict] || 0) + 1;
  const edges = perSymbol.filter((r) => r.verdict === 'edge');

  const report = {
    generatedAt: Date.now(),
    source: label,
    tripPct: trip * 100,
    horizon: HORIZON,
    entries: ENTRIES,
    bars: BARS,
    replicates: REPLICATES,
    minEpisodes: MIN_EPISODES,
    counts,
    perSymbol,
  };
  writeJson(DATA_DIR, 'dislocation.json', report);
  console.log(`\nЗаписано: ${DATA_DIR}/dislocation.json`);

  printSummary(report, edges);
}

function printSummary(rep, edges) {
  const out = [];
  out.push('# Расхождения спот/перп\n');
  out.push(`Источник: ${rep.source}. Круговые издержки на обе ноги: ` +
    `**${n3(rep.tripPct)}%**. Пороги входа заданы в её кратных, горизонт ` +
    `${rep.horizon} баров, контроль — ${rep.replicates} случайных блужданий той же ` +
    'шероховатости на каждый порог.\n');

  out.push('## Что здесь измеряется\n');
  out.push('Не прогноз. Перп и спот — один актив, связанный механизмом фандинга; ' +
    'их зазор притянут к нулю конструкцией биржи, а не чьим-то мнением. Вопрос ' +
    'только в том, расходятся ли они настолько, чтобы окупить двойное пересечение ' +
    'спреда.\n');
  out.push('**Случайное блуждание тоже иногда «сходится»** — оно забредает обратно за ' +
    'свою стартовую точку. Поэтому каждый порог сравнивается с тем же правилом, ' +
    'прогнанным по ряду с той же шероховатостью и без возврата к нулю по ' +
    'построению. Флажок ⚑ ставится только там, где строка **и прибыльна, и** ' +
    'обыгрывает блуждание: на блуждании это правило платит пошлину снова и снова, ' +
    'поэтому «лучше случайного» регулярно оказывается всё ещё убыточным.\n');

  out.push('## Итог по вселенной\n');
  out.push('| Вердикт | Монет |', '|---|---:|');
  const names = {
    edge: 'край найден', thin: 'мало эпизодов', noise: 'неотличимо от блуждания',
    negative: 'убыточно после издержек', 'no-excursions': 'расхождений нет',
    degenerate: 'вырожденный вход',
  };
  for (const [k, v] of Object.entries(rep.counts)) out.push(`| ${names[k] || k} | ${v} |`);
  out.push('');

  if (edges.length) {
    out.push('## Монеты, где край найден\n');
    out.push('| Монета | Порог | Эпизодов | Винрейт | Сошлось | Медиана баров | Годовых | Блуждание | Проц. |',
      '|---|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of edges) {
      const b = r.best;
      out.push(`| ${r.symbol}${r.sameVenue ? '' : ' ⚠'} | ${n2(b.enterPct)}% | ${b.count} | ` +
        `${pc(b.winRate)} | ${b.converged} | ${n2(b.medianBars)} | **${n2(b.annualPct)}%** | ` +
        `${n2(b.nullAnnualP50)}% | ${b.percentile == null ? '—' : (b.percentile * 100).toFixed(0)} |`);
    }
    out.push('');
  } else {
    out.push('## Края не найдено\n');
    out.push('Ни по одной монете расхождение не обыграло случайное блуждание, оставаясь ' +
      'при этом прибыльным. Это ответ, а не отсутствие ответа.\n');
  }

  out.push('## Все монеты\n');
  out.push('| Монета | Вердикт | σ базиса | Лучший порог | Эпизодов | Годовых | Блуждание |',
    '|---|---|---:|---:|---:|---:|---:|');
  for (const r of rep.perSymbol) {
    const b = r.best;
    out.push(`| ${r.symbol}${r.sameVenue ? '' : ' ⚠'} | ${names[r.verdict] || r.verdict} | ` +
      `${n3(r.basisSdPct)}% | ${b ? `${n2(b.enterPct)}%${b.beatsWalk ? ' ⚑' : ''}` : '—'} | ` +
      `${b ? b.count : '—'} | ${b ? `${n2(b.annualPct)}%` : '—'} | ` +
      `${b ? `${n2(b.nullAnnualP50)}%` : '—'} |`);
  }
  out.push('');
  if (rep.perSymbol.some((r) => !r.sameVenue)) {
    out.push('⚠ — спот взят с другой площадки: такой базис шире по построению и ' +
      'сравнивать его с одноплощадочным напрямую нельзя.\n');
  }

  const md = out.join('\n');
  console.log('\n' + md);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + '\n');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
