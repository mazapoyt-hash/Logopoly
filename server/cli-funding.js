/**
 * Funding-harvest measurement run.
 *
 * Separate job from the deep analysis for the same reason that one is separate
 * from the scan: it asks a different question, off a different host, and the
 * answer moves over weeks. It writes data/funding.json for the site and a
 * markdown summary for the Actions run.
 *
 * It decides nothing. The output is evidence about a trade that either pays or
 * does not; whether to put money on it is a decision made by reading the table.
 */
import fs from 'node:fs';

import * as funding from './sources/funding.js';
import { getHistory } from './sources/index.js';
import {
  analyseFunding, VAULT_RATIO, describeFunding, harvestCurve, reserveFundingVault,
} from './funding.js';
import { DATA_DIR, writeJson } from './staticRun.js';

/** How many settlements of history per symbol. 1000 × 8h ≈ 11 months. */
const PERIODS = Number(process.env.COINSCOPE_FUNDING_PERIODS || 2000);
const UNIVERSE = Number(process.env.COINSCOPE_FUNDING_UNIVERSE || 25);
const MIN_VOLUME = Number(process.env.COINSCOPE_MIN_VOLUME || 50e6);
const TOP_K = Number(process.env.COINSCOPE_FUNDING_TOPK || 5);
/** Candles per symbol for basis and liquidation risk. */
const BASIS_BARS = Number(process.env.COINSCOPE_FUNDING_BARS || 1500);
const OPEN_VAULT = process.env.COINSCOPE_OPEN_VAULT === '1';

const pct4 = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(4)}%`);
const n1 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(1));
const n2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
const day = (ms) => (ms ? new Date(ms).toISOString().slice(0, 10) : '—');

async function main() {
  /*
   * The venue is resolved first and reported, because two live runs were lost to
   * a gate (Binance futures answering 202 with an empty body from CI) and the
   * logs did not say which host, path or status. If every venue is closed, the
   * failure prints the full attempt log: a run that cannot measure should at
   * least explain itself well enough that the next attempt is not a guess.
   */
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

  /* ------------------------------ funding ----------------------------- */
  const fundingBySymbol = {};
  for (const symbol of symbols) {
    try {
      const points = await funding.getFunding(symbol, PERIODS, {
        onPage: ({ fetched, want }) => process.stdout.write(`\r  ${symbol}: ${fetched}/${want}   `),
      });
      if (points.length >= 100) fundingBySymbol[symbol] = points;
      else console.log(`\n  ${symbol}: всего ${points.length} выплат — мало, пропускаю`);
    } catch (err) {
      console.log(`\n  ${symbol}: ${err.message}`);
    }
  }
  process.stdout.write('\r');
  const got = Object.keys(fundingBySymbol);
  console.log(`История фандинга собрана по ${got.length} монетам.`);
  if (!got.length) {
    console.error('Ни одной истории фандинга — прекращаю. Все запросы:');
    console.error(funding.describeAttempts());
    process.exit(1);
  }

  /* ------------------- basis and liquidation inputs -------------------- */
  /*
   * Only a few symbols, and deliberately so. Basis risk is a property of the
   * spot/perp pair mechanism, not of the individual coin, so paging candles for
   * twenty-five of them would add minutes of exchange traffic to sharpen a
   * number that is already the same order everywhere.
   */
  const basisSymbols = got.slice(0, 3);
  const spotBySymbol = {};
  const perpBySymbol = {};
  for (const symbol of basisSymbols) {
    try {
      perpBySymbol[symbol] = await funding.getPerpKlines(symbol, '1h', BASIS_BARS);
      spotBySymbol[symbol] = await getHistory(symbol, '1h', BASIS_BARS);
      console.log(`  базис ${symbol}: перп ${perpBySymbol[symbol].length}, спот ${spotBySymbol[symbol].length} свечей`);
    } catch (err) {
      console.log(`  базис ${symbol}: ${err.message}`);
    }
  }

  /* ------------------------------ analyse ------------------------------ */
  const report = analyseFunding({
    fundingBySymbol, spotBySymbol, perpBySymbol,
    topK: TOP_K, source: label, vaultRatio: VAULT_RATIO,
  });
  report.universe = {
    requested: UNIVERSE, measured: got.length, minQuoteVolume: MIN_VOLUME,
    route: funding.activeVenue()?.route ?? null,
  };
  report.periodsRequested = PERIODS;
  report.venue = funding.activeVenue()?.id ?? null;
  /*
   * Where the two legs live. A Bybit perpetual against a Binance spot leg is a
   * real position, but its basis is the spread BETWEEN venues — a wider risk
   * than the same-venue version, and the report has to say so rather than let
   * the number pass for the tighter thing.
   */
  report.legs = {
    perp: report.venue, spot: 'binance',
    crossVenue: report.venue != null && report.venue !== 'binance-futures',
  };

  /*
   * The vault, opened only on demand and logged when it is. Opening it is the
   * one irreversible act in the whole measurement: once a held-back slice has
   * been looked at, it can never again answer the question it was reserved for.
   */
  if (OPEN_VAULT) {
    const { vault } = reserveFundingVault(fundingBySymbol, VAULT_RATIO);
    const all = Object.values(vault).flat().sort((a, b) => a.time - b.time);
    const desc = describeFunding(all);
    const ref = report.perSymbol.find((r) => r.periodsPerYear > 0);
    if (desc && ref) {
      desc.periodsPerYear = ref.periodsPerYear;
      desc.annualOnCapital = (desc.meanRate * ref.periodsPerYear) / report.capitalPerNotional;
    }
    report.vaultResult = {
      openedAt: Date.now(), ...report.vault,
      meanRate: desc?.meanRate ?? null,
      annualOnCapitalPct: desc ? desc.annualOnCapital * 100 : null,
      workingAnnualPct: report.portfolio ? report.portfolio.annualOnCapital * 100 : null,
      curve: harvestCurve(desc),
    };
  }

  writeJson(DATA_DIR, 'funding.json', report);
  console.log(`\nОтчёт записан: ${DATA_DIR}/funding.json`);

  summary(report);
}

function summary(rep) {
  const out = [];
  const p = rep.portfolio;
  out.push('## Сбор фандинга: что измерено');
  out.push('');
  out.push(`Источник: \`${rep.source}\` · перпетуалов: ${rep.universe.measured} · ` +
    `плечо на шорте: ${rep.leverage}× · круговые издержки пары: **${n2(rep.roundTripPct)}%** (4 пересечения).`);
  out.push('');

  if (!rep.measured) {
    out.push('> ⚠️ **Это не рынок.** Запуск прошёл на генераторе, и всё ниже описывает его, ' +
      'а не биржу. Настоящие числа даёт запуск с `COINSCOPE_SOURCE=binance`.');
    out.push('');
  }

  out.push(`### Вывод`);
  out.push('');
  out.push(rep.verdict.text);
  out.push('');

  if (p) {
    out.push('### Доход');
    out.push('');
    out.push('| | |');
    out.push('|---|---:|');
    out.push(`| Средняя выплата за ${n1(p.intervalHours)} ч | ${pct4(p.meanRate)} |`);
    out.push(`| Медианная выплата | ${pct4(p.medianRate)} |`);
    out.push(`| Доля выплат, где платим мы | ${n1(p.negativeShare * 100)}% |`);
    out.push(`| Годовых на номинал (без издержек) | ${n1(p.annualGross * 100)}% |`);
    out.push(`| Годовых на **капитал** (без издержек) | **${n1(p.annualOnCapital * 100)}%** |`);
    out.push(`| Окупить вход и выход | ${n1(p.breakEvenPeriods)} выплат ≈ ${n1(p.breakEvenDays)} дней |`);
    out.push(`| Период | ${day(p.from)} — ${day(p.to)}, ${p.periods} выплат |`);
    out.push('');
    out.push(`Капитал на единицу номинала: ${n2(rep.capitalPerNotional)}× — спот оплачивается ` +
      'целиком, шорт идёт на марже. Поэтому «фандинг × число выплат в году» завышает доход ' +
      'на эту величину, и это самая частая ошибка в таких расчётах.');
    out.push('');
  }

  if (rep.curve) {
    out.push('### Сколько держать');
    out.push('');
    out.push('| Дней | Выплат | Собрано | Издержки | Итого на капитал | Годовых |');
    out.push('|---:|---:|---:|---:|---:|---:|');
    for (const r of rep.curve.rows) {
      const net = r.netPct >= 0 ? `+${n2(r.netPct)}` : `−${n2(Math.abs(r.netPct))}`;
      out.push(`| ${r.days} | ${n1(r.periods)} | ${n2(r.grossPct)}% | −${n2(r.costPct)}% | ` +
        `${net}% | ${r.profitable ? n1(r.annualPct) + '%' : '—'} |`);
    }
    out.push('');
    if (rep.curve.firstProfitable) {
      out.push(`Короче ${rep.curve.firstProfitable.days} дней позиция окупает только собственное ` +
        'исполнение. Потолок при бесконечном удержании — ' +
        `${n1(rep.curve.ceilingAnnualPct)}% годовых, и приблизиться к нему значит взять на себя ` +
        'все риски ниже.');
      out.push('');
    }
  }

  if (rep.persistence) {
    const q = rep.persistence;
    const VERDICT = {
      persists: '**отбор работает** — прошлый фандинг предсказывает будущий',
      weak: 'отбор слабо работает — на границе шума',
      unclear: 'неясно',
      none: '**отбор не работает** — выбранные монеты не отличаются от случайных',
    };
    out.push('### Можно ли выбирать монеты');
    out.push('');
    out.push(`Ранжируем по первой половине истории, проверяем на второй, которую ранжирование ` +
      `не видело. Итог: ${VERDICT[q.verdict]}.`);
    out.push('');
    out.push('| | |');
    out.push('|---|---:|');
    out.push(`| Ранговая корреляция половин (Спирмен) | ${n2(q.rank.rho)} (p=${n2(q.rank.p)}) |`);
    out.push(`| Топ-${q.topK} по первой половине, годовых на второй | ${n1(q.pickedAnnualPct)}% |`);
    out.push(`| Вся вселенная, годовых на второй | ${n1(q.universeAnnualPct)}% |`);
    out.push(`| Случайные ${q.topK} монет: наш выбор выше | ${n1(q.nullPercentile)}% случаев |`);
    out.push(`| Случайный выбор, 95-й процентиль | ${n1(q.nullP95AnnualPct)}% годовых |`);
    out.push('');
    out.push('Случайный бенчмарк здесь обязателен: когда почти все монеты платят положительный ' +
      'фандинг, **любой** выбор выглядит прибыльным вне выборки. Без сравнения со случайным ' +
      'отбором это была бы ровно та ошибка, которую поймал бенчмарк случайных входов в стратегии.');
    out.push('');
  }

  if (rep.shortLegRisk) {
    const s = rep.shortLegRisk;
    out.push('### Риск шорт-ноги');
    out.push('');
    out.push(`На плече ${s.leverage}× шорт ликвидируется при росте на ${n1(s.liquidationPct)}%. ` +
      `За ${s.holdBars} часов удержания (${rep.intendedHoldDays} дней) на истории ${s.symbol}: ` +
      `медианный максимальный рост ${n1(s.medianRisePct)}%, 95-й процентиль ${n1(s.p95RisePct)}%, ` +
      `максимум ${n1(s.maxRisePct)}%. Ликвидация доставалась в **${n1(s.breachShare * 100)}%** окон.`);
    out.push('');
    out.push(`Спот растёт на столько же, но этот рост лежит в другом аккаунте и ликвидацию не ` +
      `останавливает. Плечо, при котором ни одно окно этой истории не дотянулось бы до ` +
      `ликвидации: ${n1(s.safeLeverage)}×.`);
    out.push('');
  }

  const withBasis = rep.perSymbol.filter((r) => r.basis);
  if (withBasis.length) {
    out.push('### Базис: насколько «нейтральная» позиция нейтральна');
    out.push('');
    if (rep.legs?.crossVenue) {
      out.push(`Ноги лежат на разных площадках: шорт на \`${rep.legs.perp}\`, спот на ` +
        `\`${rep.legs.spot}\`. Это рабочая конструкция, но базис здесь — спред **между** ` +
        'площадками, а он шире внутриплощадочного. Читать эти числа как базис одной биржи нельзя.');
      out.push('');
    }
    if (withBasis.every((r) => r.basis.degenerate)) {
      out.push('Базис вышел ровно нулевым на всех парах. На рынке так не бывает: перпетуал и спот ' +
        'расходятся постоянно — именно за это расхождение и платят фандинг. Значит, источник не ' +
        'различает перп и спот (генератор отдаёт одну и ту же серию дважды), и **единственный ' +
        'нехеджированный риск сделки здесь просто не измерен**. Показывать ноль было бы худшим ' +
        'из возможных вариантов: он выглядит как идеальная нейтральность.');
      out.push('');
    } else {
      out.push('| Монета | Средний базис | σ | 5% | 95% | Размах / издержки |');
      out.push('|---|---:|---:|---:|---:|---:|');
      for (const r of withBasis) {
        const b = r.basis;
        out.push(`| ${r.symbol} | ${n2(b.meanPct)}% | ${n2(b.sdPct)}% | ${n2(b.p5Pct)}% | ` +
          `${n2(b.p95Pct)}% | ${b.degenerate ? 'не измерен' : n2(b.swingVsTripCost) + '×'} |`);
      }
      out.push('');
      out.push('Последняя колонка — главная: размах базиса против круговых издержек. Больше 1 значит, ' +
        'что момент входа и выхода влияет на итог сильнее, чем комиссия.');
      out.push('');
    }
  }

  out.push('### По монетам');
  out.push('');
  out.push('| Монета | Выплат | Средняя | Отриц. | Годовых на капитал | Окупаемость | Макс. просадка фандинга |');
  out.push('|---|---:|---:|---:|---:|---:|---:|');
  for (const r of rep.perSymbol.slice(0, 25)) {
    const payback = Number.isFinite(r.breakEvenDays) ? `${n1(r.breakEvenDays)} дн` : 'никогда';
    out.push(`| ${r.symbol} | ${r.periods} | ${pct4(r.meanRate)} | ${n1(r.negativeShare * 100)}% | ` +
      `${n1(r.annualOnCapital * 100)}% | ${payback} | ` +
      `−${n2(r.drawdown?.maxDrawdownPct)}% (${r.drawdown?.longestNegativeRun ?? '—'} подряд) |`);
  }
  out.push('');

  if (rep.compound) {
    const c = rep.compound;
    out.push('### Сложный процент при измеренной ставке');
    out.push('');
    out.push(`Ставка ${n1(c.annualPct)}% годовых, ` +
      (c.doublingYears ? `удвоение счёта за **${n1(c.doublingYears)} года**.` : 'счёт не растёт.'));
    out.push('');
    out.push('| Лет | Множитель | Из $100 |');
    out.push('|---:|---:|---:|');
    for (const r of c.rows) out.push(`| ${r.years} | ${n2(r.factor)}× | $${n1(r.value)} |`);
    out.push('');
    out.push('Сложный процент не нуждается в защите: он работает на любой положительной ставке. ' +
      'Чего он не делает — так это не меняет саму ставку. Удвоение переводит доходность в ' +
      'единственную единицу, которая выравнивает ожидания.');
    out.push('');
  }

  out.push('### Отложенная часть');
  out.push('');
  if (rep.vaultResult) {
    const v = rep.vaultResult;
    out.push(`Открыта: ${v.periods} выплат, ${day(v.from)} — ${day(v.to)}. ` +
      `Годовых на капитал: **${n1(v.annualOnCapitalPct)}%** против ${n1(v.workingAnnualPct)}% ` +
      'на рабочей выборке.');
  } else {
    out.push(`${rep.vault.periods} выплат (${Math.round(VAULT_RATIO * 100)}% истории), ` +
      `${day(rep.vault.from)} — ${day(rep.vault.to)}, ${rep.vault.symbols} монет — ` +
      'не участвуют ни в одном числе выше. Открываются запуском с `COINSCOPE_OPEN_VAULT=1`, ' +
      'и это одноразовая операция: один раз посмотрев, уже нельзя задать вопрос, для которого ' +
      'слой откладывался.');
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
