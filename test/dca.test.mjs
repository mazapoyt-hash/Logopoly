/**
 * Знаменатель: тесты нацелены на способы сделать усреднение красивее, чем оно
 * есть.
 *
 * У этого измерения три соблазна, и ни один не требует арифметической ошибки:
 *
 *  - показать один сценарий вместо распределения (то есть одну дату старта,
 *    выбранную задним числом);
 *  - забыть, что каждый взнос — это сделка с издержками;
 *  - посчитать годовую ставку как (итог/вложено)^(1/лет), то есть обычным CAGR.
 *
 * Третий — самый коварный, и коварен он не тем, о чём думаешь сначала. CAGR
 * здесь ЗАНИЖАЕТ ставку примерно вдвое: он считает, будто вся сумма лежала с
 * первого дня, тогда как средний доллар отработал около половины срока.
 * Заниженная доходность «ничего не делать» — это сравнение, подкрученное в
 * пользу стратегий, то есть ровно та ошибка, которую здесь нельзя допускать.
 */
import { makeChecker, close } from './helpers.mjs';
import {
  contributionBars, dcaRun, impliedAnnualPct, startDistribution,
  basketCandles, yearsToIncome, annualFromR, describeDca,
} from '../server/dca.js';

const results = [];
const check = makeChecker(results);

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/** Часовые свечи с заданной ценой: либо постоянной, либо по функции. */
function series(n, price, { start = Date.UTC(2021, 0, 1), step = HOUR } = {}) {
  return Array.from({ length: n }, (_, i) => {
    const p = typeof price === 'function' ? price(i) : price;
    return { time: start + i * step, open: p, high: p, low: p, close: p, volume: 1 };
  });
}

/* ------------------------------- взносы -------------------------------- */

check('взнос приходится на первый бар каждого календарного месяца', (() => {
  // 90 дней с 1 января — это ровно январь, февраль и март (31+28+31), то есть
  // три взноса: 1 апреля в серию уже не попадает.
  const bars = contributionBars(series(90, 100, { step: DAY }));
  return bars.length === 3 && bars[0] === 0 && bars[1] === 31 && bars[2] === 59;
})());

check('«раз в месяц» — это календарь, а не фиксированный шаг в барах', (() => {
  // Февраль короче января: расстояние между взносами обязано отличаться.
  const bars = contributionBars(series(120, 100, { step: DAY }));
  const gaps = bars.slice(1).map((b, i) => b - bars[i]);
  return new Set(gaps).size > 1;
})());

check('один бар — один взнос, а не ноль',
  contributionBars(series(1, 100)).length === 1);

check('пустая серия не даёт взносов', contributionBars([]).length === 0);

/* ------------------------------ один прогон ---------------------------- */

check('при неизменной цене итог равен вложенному минус издержки', (() => {
  const r = dcaRun(series(90, 100, { step: DAY }), { monthly: 100, costRate: 0.001 });
  return r.months === 3 && close(r.invested, 300, 1e-9)
    && close(r.value, 300 * 0.999, 1e-6);
})());

/*
 * Издержки на каждой покупке. Усреднение выглядит бесплатным ровно до тех пор,
 * пока про это не вспомнишь, а сравнение со стратегией, которая свои издержки
 * платит, без этого нечестно.
 */
check('издержки снимаются с каждого взноса, а не один раз', (() => {
  const free = dcaRun(series(90, 100, { step: DAY }), { monthly: 100, costRate: 0 });
  const paid = dcaRun(series(90, 100, { step: DAY }), { monthly: 100, costRate: 0.01 });
  // Три взноса по 1% — итог ровно на 1% ниже, потому что цена постоянна.
  return close(paid.value / free.value, 0.99, 1e-9);
})());

check('рост цены превращается в прибыль, падение — в убыток', (() => {
  const up = dcaRun(series(90, (i) => 100 + i, { step: DAY }), { monthly: 100 });
  const down = dcaRun(series(90, (i) => 190 - i, { step: DAY }), { monthly: 100 });
  return up.profit > 0 && down.profit < 0;
})());

check('поздний старт даёт меньше взносов', (() => {
  const all = dcaRun(series(90, 100, { step: DAY }), { monthly: 100 });
  const late = dcaRun(series(90, 100, { step: DAY }), { startIndex: 45, monthly: 100 });
  return late.months < all.months && late.invested < all.invested;
})());

check('нулевая или отрицательная цена не создаёт бесконечных единиц', (() => {
  const r = dcaRun(series(90, (i) => (i < 40 ? 0 : 100), { step: DAY }), { monthly: 100 });
  return Number.isFinite(r.value) && r.value >= 0;
})());

check('старт за пределами данных не даёт прогона',
  dcaRun(series(10, 100), { startIndex: 99 }) === null
  && dcaRun([], {}) === null);

/* --------------------------- подразумеваемая ставка -------------------- */

/*
 * Допуск не 1e-9: у формулы аннуитета при ставке около нуля катастрофическое
 * сокращение в ((1+m)^n - 1)/m, поэтому корень находится с точностью порядка
 * 1e-6 процента годовых. Это 0.000001% — величина, не имеющая смысла ни в
 * одном отчёте, и требовать от неё большего значит тестировать арифметику
 * с плавающей точкой, а не модуль.
 */
check('при нулевом росте подразумеваемая ставка равна нулю',
  close(impliedAnnualPct({ monthly: 100, months: 12, value: 1200 }), 0, 1e-4));

check('удвоение вложенного даёт положительную ставку',
  impliedAnnualPct({ monthly: 100, months: 12, value: 2400 }) > 0);

check('потеря половины даёт отрицательную ставку',
  impliedAnnualPct({ monthly: 100, months: 12, value: 600 }) < 0);

check('ставка растёт монотонно по итоговой сумме', (() => {
  const a = impliedAnnualPct({ monthly: 100, months: 36, value: 4000 });
  const b = impliedAnnualPct({ monthly: 100, months: 36, value: 5000 });
  const c = impliedAnnualPct({ monthly: 100, months: 36, value: 6000 });
  return a < b && b < c;
})());

/*
 * Ключевая проверка, и направление у неё обратное интуиции. CAGR считает, будто
 * вся сумма лежала с первого дня; на деле средний доллар отработал около
 * половины срока, поэтому настоящая ставка ПРИМЕРНО ВДВОЕ ВЫШЕ наивной.
 * Пойман этой же проверкой на первом прогоне: и комментарий в модуле, и сам
 * тест утверждали обратное.
 */
check('настоящая ставка выше наивного CAGR примерно вдвое', (() => {
  for (const months of [24, 60, 120]) {
    const value = 100 * months * 2;                 // всегда ×2 от вложенного
    const naive = (Math.pow(2, 1 / (months / 12)) - 1) * 100;
    const real = impliedAnnualPct({ monthly: 100, months, value });
    const ratio = real / naive;
    if (!(ratio > 1.7 && ratio < 2.3)) return false;
  }
  return true;
})());

check('разрыв с наивным CAGR сужается с горизонтом, а не растёт', (() => {
  const gap = (months) => {
    const value = 100 * months * 2;
    const naive = (Math.pow(2, 1 / (months / 12)) - 1) * 100;
    return impliedAnnualPct({ monthly: 100, months, value }) - naive;
  };
  return gap(24) > gap(60) && gap(60) > gap(120) && gap(120) > 0;
})());

check('подставив найденную ставку обратно, получаем исходную сумму', (() => {
  const months = 48;
  const value = 9000;
  const a = impliedAnnualPct({ monthly: 100, months, value });
  const m = Math.pow(1 + a / 100, 1 / 12) - 1;
  const back = 100 * ((Math.pow(1 + m, months) - 1) / m);
  return Math.abs(back - value) / value < 1e-6;
})());

check('бессмысленный вход не даёт ставки',
  impliedAnnualPct({ monthly: 0, months: 12, value: 100 }) === null
  && impliedAnnualPct({ monthly: 100, months: 0, value: 100 }) === null
  && impliedAnnualPct({ monthly: 100, months: 12, value: 0 }) === null);

/* --------------------------- распределение стартов --------------------- */

check('распределение считает все даты старта, а не одну', (() => {
  const d = startDistribution(series(365 * 3, 100, { step: DAY }), { minYears: 1 });
  return d.scenarios > 10;
})());

check('короткие сценарии отсечены порогом горизонта', (() => {
  const d = startDistribution(series(365 * 3, 100, { step: DAY }), { minYears: 2 });
  return d.runs.every((r) => r.years >= 2);
})());

check('худший не лучше медианного, медианный не лучше лучшего', (() => {
  const d = startDistribution(series(365 * 3, (i) => 100 + 40 * Math.sin(i / 60), { step: DAY }),
    { minYears: 1 });
  const m = d.multiple;
  return m.worst <= m.p25 && m.p25 <= m.median && m.median <= m.p75 && m.p75 <= m.best;
})());

/*
 * Один прогон — история про одну дату. На пиле разброс между лучшим и худшим
 * стартом обязан быть заметным, иначе распределение не несёт информации и
 * показывать медиану как ответ было бы враньём.
 */
check('дата старта меняет исход, и распределение это показывает', (() => {
  const d = startDistribution(series(365 * 3, (i) => 100 + 60 * Math.sin(i / 90), { step: DAY }),
    { minYears: 1 });
  return d.multiple.best > d.multiple.worst * 1.1;
})());

check('доля убыточных стартов считается, а не подразумевается нулём', (() => {
  const down = startDistribution(series(365 * 3, (i) => 400 - i / 4, { step: DAY }), { minYears: 1 });
  return down.lossRate > 0.5;
})());

check('на растущем рынке убыточных стартов нет', (() => {
  const up = startDistribution(series(365 * 3, (i) => 100 + i / 2, { step: DAY }), { minYears: 1 });
  return up.lossRate === 0;
})());

check('слишком короткая история не даёт распределения',
  startDistribution(series(30, 100, { step: DAY }), { minYears: 5 }) === null
  && startDistribution([], {}) === null);

/* --------------------------------- корзина ----------------------------- */

check('корзина строится только по общим меткам времени', (() => {
  const a = series(100, 100, { step: DAY });
  const b = series(100, 200, { step: DAY }).filter((_, i) => i !== 50);
  return basketCandles({ a, b }).length === 99;
})());

check('корзина из одной монеты повторяет её форму', (() => {
  const a = series(50, (i) => 100 + i, { step: DAY });
  const bk = basketCandles({ a });
  return close(bk[49].close / bk[0].close, a[49].close / a[0].close, 1e-9);
})());

check('веса равные: удвоение одной монеты из двух даёт +50% индексу', (() => {
  const a = series(10, (i) => (i === 9 ? 200 : 100), { step: DAY });
  const b = series(10, 100, { step: DAY });
  const bk = basketCandles({ a, b });
  return close(bk[9].close / bk[0].close, 1.5, 1e-9);
})());

check('дорогая монета не получает больший вес из-за своей цены', (() => {
  const cheap = series(10, (i) => (i === 9 ? 2 : 1), { step: DAY });
  const dear = series(10, 50000, { step: DAY });
  const bk = basketCandles({ cheap, dear });
  return close(bk[9].close / bk[0].close, 1.5, 1e-9);
})());

check('пустой вход даёт пустую корзину',
  basketCandles({}).length === 0 && basketCandles(null).length === 0);

/* ---------------------------------- цель ------------------------------- */

check('при 30% годовых $100 в месяц идут к $50k дохода около 14 лет', (() => {
  const r = yearsToIncome({ monthly: 100, annualPct: 30, incomePerYear: 50000 });
  return r.reachable && r.years > 12 && r.years < 16;
})());

check('меньшая ставка — больший срок', (() => {
  const slow = yearsToIncome({ monthly: 100, annualPct: 10, incomePerYear: 50000 });
  const fast = yearsToIncome({ monthly: 100, annualPct: 30, incomePerYear: 50000 });
  return slow.years > fast.years;
})());

check('при неположительной ставке цель недостижима никаким временем', (() => {
  const zero = yearsToIncome({ monthly: 100, annualPct: 0, incomePerYear: 50000 });
  const neg = yearsToIncome({ monthly: 100, annualPct: -10, incomePerYear: 50000 });
  return zero.reachable === false && neg.reachable === false
    && Number.isFinite(neg.ceiling);
})());

check('нужный капитал — это доход, делённый на ставку', (() => {
  const r = yearsToIncome({ monthly: 100, annualPct: 25, incomePerYear: 50000 });
  return close(r.capitalNeeded, 200000, 1e-6);
})());

/* -------------------------- стратегия в годовую ставку ------------------ */

check('нулевая сумма R даёт нулевую ставку',
  close(annualFromR({ totalR: 0, years: 4 }).annualPct, 0, 1e-9));

check('отрицательная сумма R даёт отрицательную ставку',
  annualFromR({ totalR: -57, years: 4 }).annualPct < 0);

check('положительная сумма R даёт положительную ставку',
  annualFromR({ totalR: 57, years: 4 }).annualPct > 0);

check('больший риск на сделку усиливает и плюс, и минус', (() => {
  const small = annualFromR({ totalR: -57, years: 4, riskPerTrade: 0.005 });
  const big = annualFromR({ totalR: -57, years: 4, riskPerTrade: 0.02 });
  return big.annualPct < small.annualPct;
})());

check('приближение помечено как приближение, а не выдано за точный расчёт',
  annualFromR({ totalR: -57, years: 4 }).approximate === true);

check('бессмысленный вход не даёт ставки',
  annualFromR({ totalR: -57, years: 0 }) === null
  && annualFromR({ totalR: NaN, years: 4 }) === null);

/* --------------------------------- слова -------------------------------- */

check('описание называет и худший сценарий, и долю убыточных стартов', (() => {
  const d = startDistribution(series(365 * 3, (i) => 100 + 60 * Math.sin(i / 90), { step: DAY }),
    { minYears: 1 });
  const t = describeDca(d, { label: 'BTC' });
  return t.includes('BTC') && t.includes('худш') && t.includes('минусе');
})());

check('описание объясняет, почему худший столбец важнее медианного', (() => {
  const d = startDistribution(series(365 * 2, 100, { step: DAY }), { minYears: 1 });
  return describeDca(d).includes('не знает');
})());

check('без данных описание говорит об этом, а не выдумывает число',
  describeDca(null).includes('не хватило'));

const passed = results.filter(([, ok]) => ok).length;
console.log(`  ${passed}/${results.length} passed`);
process.exit(passed === results.length ? 0 : 1);
