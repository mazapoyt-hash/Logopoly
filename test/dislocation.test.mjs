/**
 * Расхождения: тесты нацелены на способы соврать, а не на арифметику.
 *
 * This measurement has four ways to flatter itself, and each one turns a losing
 * trade into a winning statistic without any arithmetic error:
 *
 *  - counting only the gaps that closed (survivorship);
 *  - counting one slow move as twenty opportunities (overlap);
 *  - reporting a gap smaller than the cost of crossing it (the toll);
 *  - calling a random walk's wandering "mean reversion" (the null).
 *
 * So most of what is checked below is the CONTROL. The decisive test is the
 * last group: a pure random walk must not be called an edge, and a series with
 * a real pull toward zero must be.
 */
import { makeChecker, close } from './helpers.mjs';
import {
  HORIZON, ENTRIES, basisSeries, excursions, tally, annualise,
  randomWalkLike, walkNull, spanYearsOf, measureEntry, dislocation,
  describeDislocation,
} from '../server/dislocation.js';
import { makeRng } from '../server/nulls.js';

const results = [];
const check = makeChecker(results);

const HOUR = 3600_000;
const T0 = Date.UTC(2025, 0, 1);

/** Candles whose closes are given; spot is flat at 100 unless said otherwise. */
const candles = (closes, { start = T0, step = HOUR } = {}) =>
  closes.map((c, i) => ({ time: start + i * step, open: c, high: c, low: c, close: c, volume: 1 }));

/** A basis series straight from numbers, skipping the candle plumbing. */
const seriesOf = (basises, { start = T0, step = HOUR } = {}) =>
  basises.map((b, i) => ({ time: start + i * step, basis: b }));

/**
 * A mean-reverting basis: each step pulled back toward zero by `pull`, plus
 * noise. At pull = 0 this is exactly a random walk.
 */
function mrSeries(n, { pull = 0.1, noise = 0.002, seed = 3, start = T0 } = {}) {
  const rng = makeRng(seed);
  const out = [];
  let level = 0;
  for (let i = 0; i < n; i++) {
    level += -pull * level + (rng() - 0.5) * 2 * noise;
    out.push({ time: start + i * HOUR, basis: level });
  }
  return out;
}

/* ------------------------------ выравнивание --------------------------- */

check('базис считается только по совпадающим меткам времени', (() => {
  const spot = candles([100, 100, 100]);
  const perp = candles([101, 102, 103]);
  const s = basisSeries(spot, perp);
  return s.length === 3 && close(s[0].basis, 0.01, 1e-12);
})());

check('пропущенный бар на одной площадке не сдвигает все последующие пары', (() => {
  const spot = candles([100, 100, 100]);
  const perp = candles([101, 102, 103]).filter((_, i) => i !== 1);
  const s = basisSeries(spot, perp);
  // Two pairs survive, and the second is the THIRD bar of each — not the
  // second perp bar mispaired with the third spot bar.
  return s.length === 2 && close(s[1].basis, 0.03, 1e-12);
})());

check('нулевой или отсутствующий спот не превращается в бесконечный базис', (() => {
  const spot = candles([0, 100]);
  const perp = candles([101, 101]);
  return basisSeries(spot, perp).length === 1;
})());

check('пустой вход не роняет и не выдумывает',
  basisSeries([], []).length === 0 && basisSeries(null, null).length === 0);

/* -------------------------------- эпизоды ------------------------------ */

check('порог должен быть положительным, иначе эпизодов нет',
  excursions(seriesOf([0.01, 0]), { enter: 0 }).length === 0
  && excursions(seriesOf([0.01, 0]), { enter: -1 }).length === 0);

check('схождение засчитывается, когда зазор дошёл до выходной полосы', (() => {
  const [e] = excursions(seriesOf([0.01, 0.005, 0]), { enter: 0.008 });
  return e.outcome === 'converged' && e.bars === 2 && close(e.gross, 0.01, 1e-12);
})());

check('дешёвый перп торгуется в другую сторону и даёт тот же знак прибыли', (() => {
  const [e] = excursions(seriesOf([-0.01, -0.005, 0]), { enter: 0.008 });
  return e.direction === 'perp-cheap' && close(e.gross, 0.01, 1e-12);
})());

/*
 * Выживаемость. Эпизод, который не сошёлся, обязан вернуться с отрицательным
 * результатом, а не исчезнуть из выборки: именно так убыточная сделка
 * превращается в выигрышную статистику.
 */
check('разошедшийся зазор возвращается убытком, а не выбрасывается', (() => {
  const [e] = excursions(seriesOf([0.01, 0.02, 0.03]), { enter: 0.008, horizon: 2 });
  return e.outcome === 'timeout' && e.gross < 0 && close(e.gross, -0.02, 1e-12);
})());

check('эпизод с таймаутом всё равно посчитан', (() => {
  const list = excursions(seriesOf([0.01, 0.02, 0.03, 0.04]), { enter: 0.008, horizon: 2 });
  return list.length >= 1 && list.every((e) => Number.isFinite(e.gross));
})());

/*
 * Перекрытие. Одно медленное движение, пересекающее порог на двадцати барах
 * подряд, — это одна возможность, а не двадцать.
 */
check('одно медленное движение — один эпизод, а не двадцать', (() => {
  const wide = Array(20).fill(0.01);
  const list = excursions(seriesOf([...wide, 0]), { enter: 0.008, horizon: 48 });
  return list.length === 1;
})());

check('эпизоды не перекрываются: следующий начинается после закрытия прошлого', (() => {
  const list = excursions(seriesOf([0.01, 0, 0.01, 0, 0.01, 0]), { enter: 0.008 });
  for (let i = 1; i < list.length; i++) if (list[i].at <= list[i - 1].at) return false;
  return list.length === 3;
})());

check('зазор ниже порога не открывает ничего',
  excursions(seriesOf([0.001, 0.002, 0.001]), { enter: 0.008 }).length === 0);

check('хвост данных без будущего не открывает эпизод без исхода',
  excursions(seriesOf([0, 0, 0.01]), { enter: 0.008 }).every((e) => e.bars > 0));

/* --------------------------------- подсчёт ----------------------------- */

check('пошлина вычитается из каждого эпизода', (() => {
  const list = excursions(seriesOf([0.01, 0]), { enter: 0.008 });
  const t = tally(list, { trip: 0.004 });
  return close(t.netMean, 0.006, 1e-12) && close(t.grossMean, 0.01, 1e-12);
})());

check('зазор меньше пошлины даёт отрицательную сделку, как и должен', (() => {
  const t = tally(excursions(seriesOf([0.01, 0]), { enter: 0.008 }), { trip: 0.02 });
  return t.netMean < 0 && t.winRate === 0;
})());

check('пустой список не выдумывает винрейт', (() => {
  const t = tally([], { trip: 0.001 });
  return t.count === 0 && t.winRate === null && t.netTotal === 0;
})());

check('сошедшиеся и таймауты считаются отдельно', (() => {
  const list = [
    { gross: 0.01, bars: 2, outcome: 'converged' },
    { gross: -0.01, bars: 5, outcome: 'timeout' },
  ];
  const t = tally(list, { trip: 0.001 });
  return t.converged === 1 && t.timeouts === 1 && t.count === 2;
})());

/* ------------------------------- в год --------------------------------- */

check('годовая ставка — это размер, умноженный на измеренную частоту', (() => {
  const t = { count: 10, netMean: 0.002 };
  const a = annualise(t, 2);
  return close(a.perYear, 5, 1e-12) && close(a.annualPct, 1, 1e-9);
})());

check('без эпизодов или без срока годовой ставки нет',
  annualise({ count: 0, netMean: 0.01 }, 1) === null
  && annualise({ count: 5, netMean: 0.01 }, 0) === null);

check('срок берётся из меток времени, а не из числа баров',
  close(spanYearsOf(seriesOf(Array(8767).fill(0))), 1, 0.01));

check('срок короче двух точек равен нулю',
  spanYearsOf([]) === 0 && spanYearsOf(seriesOf([0])) === 0);

/* ------------------------- случайное блуждание -------------------------- */

check('подделка сохраняет длину и метки времени', (() => {
  const s = mrSeries(200);
  const f = randomWalkLike(s, makeRng(1));
  return f.length === s.length && f.every((p, i) => p.time === s[i].time);
})());

check('подделка стартует из той же точки', (() => {
  const s = mrSeries(200);
  return randomWalkLike(s, makeRng(1))[0].basis === s[0].basis;
})());

/*
 * Главное свойство контроля: шероховатость сохраняется, возврат к нулю — нет.
 * Если бы подделка была спокойнее оригинала, она реже доходила бы до порога, и
 * любой шум выглядел бы открытием.
 */
check('подделка примерно так же шероховата, как оригинал', (() => {
  const s = mrSeries(3000, { pull: 0.05, noise: 0.002, seed: 9 });
  const step = (list) => {
    const d = [];
    for (let i = 1; i < list.length; i++) d.push(Math.abs(list[i].basis - list[i - 1].basis));
    return d.reduce((a, b) => a + b, 0) / d.length;
  };
  const a = step(s);
  const b = step(randomWalkLike(s, makeRng(4)));
  return Math.abs(a - b) / a < 0.15;
})());

check('подделка теряет возврат к нулю: она уходит дальше от старта', (() => {
  const s = mrSeries(3000, { pull: 0.08, noise: 0.002, seed: 12 });
  const far = (list) => Math.max(...list.map((p) => Math.abs(p.basis)));
  return far(randomWalkLike(s, makeRng(6))) > far(s);
})());

check('слишком короткий ряд возвращается как есть, а не падает',
  randomWalkLike(seriesOf([0.01, 0.02]), makeRng(1)).length === 2
  && randomWalkLike([], makeRng(1)).length === 0);

check('контроль детерминирован при фиксированном зерне', (() => {
  const s = mrSeries(800, { seed: 21 });
  const o = { enter: 0.004, horizon: 24, trip: 0.001, spanYears: 1 };
  const a = walkNull(s, o, { replicates: 25, seed: 77 });
  const b = walkNull(s, o, { replicates: 25, seed: 77 });
  return a.annual.p50 === b.annual.p50;
})());

check('контроль меняется с зерном, иначе он ничего не выбирает', (() => {
  const s = mrSeries(800, { seed: 21 });
  const o = { enter: 0.004, horizon: 24, trip: 0.001, spanYears: 1 };
  return walkNull(s, o, { replicates: 25, seed: 1 }).annual.p50
    !== walkNull(s, o, { replicates: 25, seed: 2 }).annual.p50;
})());

/* --------------------------- решающие проверки -------------------------- */

/*
 * Случайное блуждание тоже иногда «сходится» — оно забредает обратно за свою
 * стартовую точку. Правило, которое ждёт большого отклонения и ставит на
 * возврат, покажет прибыль на чистом шуме, если контроля нет. Это и есть тот
 * самый детектор, ради которого написан модуль.
 */
check('чистое блуждание не называется краем', (() => {
  for (const seed of [11, 29, 53, 71]) {
    const walk = mrSeries(4000, { pull: 0, noise: 0.002, seed });
    const r = measureEntry(walk, { enter: 0.006, trip: 0.0016, horizon: 48, replicates: 60, seed: 909 });
    if (r.beatsWalk) return false;
  }
  return true;
})());

/*
 * Пойман этим же набором на первом прогоне: при seed 29 блуждание давало
 * -3.99% годовых, контроль -27.9%, процентиль 97 — и флаг «обыгрывает
 * блуждание» поднимался на убыточной строке. На блуждании это правило платит
 * пошлину снова и снова, поэтому контроль сидит глубоко в минусе, и «выше 95-го
 * процентиля» срабатывает регулярно там, где деньги всё равно теряются.
 */
check('менее убыточный, чем блуждание, — это не «обыгрывает блуждание»', (() => {
  const walk = mrSeries(4000, { pull: 0, noise: 0.002, seed: 29 });
  const r = measureEntry(walk, { enter: 0.006, trip: 0.0016, horizon: 48, replicates: 60, seed: 909 });
  return r.annualPct < 0 && r.percentile >= 0.95 && r.beatsWalk === false;
})());

check('флаг требует и прибыльности, и превосходства над контролем', (() => {
  const mr = mrSeries(4000, { pull: 0.25, noise: 0.004, seed: 31 });
  const r = measureEntry(mr, { enter: 0.006, trip: 0.0004, horizon: 48, replicates: 60, seed: 909 });
  return r.beatsWalk === (r.percentile >= 0.95 && r.annualPct > 0);
})());

check('настоящий возврат к нулю находится', (() => {
  const mr = mrSeries(4000, { pull: 0.25, noise: 0.004, seed: 31 });
  const r = measureEntry(mr, { enter: 0.006, trip: 0.0004, horizon: 48, replicates: 60, seed: 909 });
  return r.beatsWalk === true && r.annualPct > 0;
})());

check('сильный возврат к нулю сходится быстрее, чем блуждание', (() => {
  const opt = { enter: 0.006, horizon: 48 };
  const mr = tally(excursions(mrSeries(4000, { pull: 0.25, noise: 0.004, seed: 5 }), opt), { trip: 0 });
  const rw = tally(excursions(mrSeries(4000, { pull: 0, noise: 0.004, seed: 5 }), opt), { trip: 0 });
  return mr.medianBars < rw.medianBars;
})());

/* ------------------------------- весь отчёт ----------------------------- */

check('нулевая пошлина или слишком короткий ряд отчёта не дают',
  dislocation(candles([100, 100]), candles([101, 101]), { trip: 0 }) === null
  && dislocation(candles([100]), candles([101]), { trip: 0.001 }) === null);

check('одна и та же серия дважды признаётся вырожденной, а не «без расхождений»', (() => {
  const c = candles(Array.from({ length: 300 }, (_, i) => 100 + Math.sin(i / 7)));
  const r = dislocation(c, c, { trip: 0.0016 });
  return r.degenerate === true && r.verdict === 'degenerate';
})());

check('блуждание получает вердикт noise или хуже, но не edge', (() => {
  const walk = mrSeries(3000, { pull: 0, noise: 0.002, seed: 44 });
  const spot = candles(Array(3000).fill(100));
  const perp = walk.map((p, i) => ({ time: spot[i].time, open: 0, high: 0, low: 0, close: 100 * (1 + p.basis), volume: 1 }));
  const r = dislocation(spot, perp, { trip: 0.0016, replicates: 40 });
  return r.verdict !== 'edge';
})());

check('каждый порог несёт свой контроль, а не общий', (() => {
  const mr = mrSeries(2500, { pull: 0.12, noise: 0.003, seed: 8 });
  const spot = candles(Array(2500).fill(100));
  const perp = mr.map((p, i) => ({ time: spot[i].time, open: 0, high: 0, low: 0, close: 100 * (1 + p.basis), volume: 1 }));
  const r = dislocation(spot, perp, { trip: 0.0008, replicates: 30 });
  return r.rows.length === ENTRIES.length
    && r.rows.every((row) => row.percentile === null || typeof row.percentile === 'number');
})());

check('пороги выражены в пошлинах, поэтому растут вместе с ней', (() => {
  const mr = mrSeries(2000, { pull: 0.1, noise: 0.003, seed: 14 });
  const spot = candles(Array(2000).fill(100));
  const perp = mr.map((p, i) => ({ time: spot[i].time, open: 0, high: 0, low: 0, close: 100 * (1 + p.basis), volume: 1 }));
  const cheap = dislocation(spot, perp, { trip: 0.0004, replicates: 20 });
  const dear = dislocation(spot, perp, { trip: 0.004, replicates: 20 });
  return dear.rows[0].enterPct > cheap.rows[0].enterPct;
})());

check('более высокий порог никогда не даёт больше эпизодов', (() => {
  const mr = mrSeries(3000, { pull: 0.1, noise: 0.003, seed: 6 });
  const spot = candles(Array(3000).fill(100));
  const perp = mr.map((p, i) => ({ time: spot[i].time, open: 0, high: 0, low: 0, close: 100 * (1 + p.basis), volume: 1 }));
  const r = dislocation(spot, perp, { trip: 0.0006, replicates: 20 });
  return r.rows.every((row, i) => i === 0 || row.count <= r.rows[i - 1].count);
})());

/* -------------------------------- слова -------------------------------- */

check('у каждого вердикта свои слова', (() => {
  const seen = new Set();
  for (const verdict of ['degenerate', 'no-excursions', 'negative', 'noise', 'thin', 'edge']) {
    const text = describeDislocation({
      verdict,
      best: { enterPct: 0.32, annualPct: 4.1, nullAnnualP50: 1.2, nullAnnualP95: 3.0, percentile: 0.97, count: 80 },
      tripPct: 0.16,
      rows: [{ count: 120 }],
    });
    if (text.length < 30 || seen.has(text)) return false;
    seen.add(text);
  }
  return true;
})());

check('«нет расхождений» называет пошлину, с которой сравнивали',
  describeDislocation({ verdict: 'no-excursions', tripPct: 0.16, rows: [{ count: 0 }] }).includes('0.16'));

check('«шум» показывает, что даёт блуждание, а не только что дала стратегия', (() => {
  const t = describeDislocation({
    verdict: 'noise',
    best: { annualPct: 2.0, nullAnnualP50: 2.4, nullAnnualP95: 5.0, percentile: 0.4 },
    tripPct: 0.16, rows: [{ count: 50 }],
  });
  return t.includes('2.40') && t.includes('5.00');
})());

check('HORIZON и ENTRIES вынесены наружу, чтобы прогон мог их назвать',
  HORIZON > 0 && ENTRIES.length >= 3 && ENTRIES.every((e) => e > 0));

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
