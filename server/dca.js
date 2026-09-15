/**
 * Знаменатель: что даёт тот же план без всякой стратегии.
 *
 * Пять направлений измерены и закрыты, и каждое сравнивалось со случайными
 * входами. Но случайный вход — это не альтернатива, которая есть у человека с
 * деньгами. Реальная альтернатива — не делать ничего умного: заносить ту же
 * сумму в те же сроки и держать.
 *
 * Ни одна стратегия в этом проекте никогда не сравнивалась с ней. Это дыра в
 * измерении, а не пробел в отчёте: стратегия, проигрывающая бездействию, —
 * отрицательный результат, даже если сама по себе она в плюсе.
 *
 * Два решения делают этот модуль измерением, а не рекламой усреднения.
 *
 *  1. ОДИН ПРОГОН — ЭТО ИСТОРИЯ ПРО ОДНУ ДАТУ СТАРТА. Начав в июне 2021-го,
 *     вы купили вершину; начав в ноябре 2022-го — дно. Разница между этими
 *     двумя числами больше, чем разница между любыми двумя стратегиями,
 *     которые мы мерили. Поэтому здесь считается не один сценарий, а ВСЕ
 *     возможные даты старта, и отчёт даёт распределение: медиану, худший
 *     случай, лучший. Человеку, который собирается начать, нужен именно
 *     худший — он не знает, в какую точку истории попал.
 *
 *  2. ИЗДЕРЖКИ ПЛАТЯТСЯ НА КАЖДОЙ ПОКУПКЕ. Усреднение выглядит бесплатным
 *     только если забыть, что каждый взнос — это сделка. На горизонте в годы
 *     это малая поправка, но она обязана быть в расчёте, иначе сравнение со
 *     стратегией, которая свои издержки платит, нечестно.
 *
 * Модуль ничего не советует. Он считает, сколько было бы денег, и передаёт
 * число туда, где решение принимает человек.
 */
import { quantile } from './nulls.js';

/** Календарный месяц в миллисекундах — только для перевода горизонта в годы. */
const MONTH_MS = 365.25 / 12 * 24 * 3600 * 1000;
const YEAR_MS = 365.25 * 24 * 3600 * 1000;

/**
 * Взносы: по одному на каждый календарный месяц внутри серии.
 *
 * Берётся первый бар каждого нового месяца, а не каждый N-й бар: «раз в месяц»
 * для человека — это календарная дата, и на часовых свечах фиксированный шаг в
 * 730 баров медленно расходится с ней.
 */
export function contributionBars(candles) {
  const out = [];
  let lastKey = null;
  for (let i = 0; i < candles.length; i++) {
    const d = new Date(candles[i].time);
    const key = `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
    if (key !== lastKey) { out.push(i); lastKey = key; }
  }
  return out;
}

/**
 * Один сценарий усреднения: покупать на `monthly` каждый месяц начиная с бара
 * `startIndex` и держать до конца серии.
 *
 * Возвращает и вложенное, и стоимость, потому что доходность в процентах на
 * растущем взносами счёте — обманчивая величина: 100% на первый взнос и 0% на
 * последний дают совсем не «50% в среднем».
 */
export function dcaRun(candles, { startIndex = 0, monthly = 100, costRate = 0.001 } = {}) {
  if (!candles?.length || startIndex >= candles.length - 1) return null;
  const bars = contributionBars(candles).filter((i) => i >= startIndex);
  if (!bars.length) return null;

  let units = 0;
  let invested = 0;
  for (const i of bars) {
    const price = candles[i].close;
    if (!(price > 0)) continue;
    // Издержки снимаются со взноса: на бирже покупается то, что осталось.
    units += (monthly * (1 - costRate)) / price;
    invested += monthly;
  }
  if (!(invested > 0)) return null;

  const last = candles[candles.length - 1];
  const value = units * last.close;
  const years = (last.time - candles[bars[0]].time) / YEAR_MS;

  return {
    from: candles[bars[0]].time,
    to: last.time,
    months: bars.length,
    years,
    invested,
    value,
    profit: value - invested,
    multiple: value / invested,
    /*
     * Годовая ставка, при которой равномерные взносы дали бы ту же сумму.
     *
     * Считается численно: аналитической формулы для аннуитета с искомой ставкой
     * нет. Соблазнительное приближение «(value/invested)^(1/years)» —  обычный
     * CAGR — здесь ЗАНИЖАЕТ ставку примерно вдвое, потому что считает, будто вся
     * сумма лежала с первого дня, тогда как средний доллар отработал около
     * половины срока. На удвоении за 5 лет это 14.9% против настоящих 29.0%.
     *
     * Направление ошибки важнее её размера: заниженная ставка «ничего не
     * делать» — это подкрученное в пользу стратегий сравнение, то есть ровно
     * та ошибка, которую здесь нельзя допускать.
     */
    annualPct: impliedAnnualPct({ monthly, months: bars.length, value }),
  };
}

/**
 * Ставка, при которой ежемесячные взносы вырастают ровно в `value`.
 *
 * Двоичный поиск по монотонной функции: будущая стоимость аннуитета строго
 * растёт по ставке, поэтому корень единственный и находится надёжно.
 */
export function impliedAnnualPct({ monthly, months, value, lo = -99.9, hi = 1000 }) {
  if (!(months > 0) || !(monthly > 0) || !(value > 0)) return null;
  const fv = (annualPct) => {
    const m = Math.pow(1 + annualPct / 100, 1 / 12) - 1;
    if (Math.abs(m) < 1e-12) return monthly * months;
    return monthly * ((Math.pow(1 + m, months) - 1) / m);
  };
  if (fv(lo) > value) return lo;
  if (fv(hi) < value) return hi;
  let a = lo;
  let b = hi;
  for (let k = 0; k < 200; k++) {
    const mid = (a + b) / 2;
    if (fv(mid) < value) a = mid; else b = mid;
  }
  return (a + b) / 2;
}

/**
 * Все возможные даты старта, а не одна.
 *
 * `minYears` отсекает хвост: сценарий, начатый за месяц до конца данных, — это
 * не «план на годы», а одна покупка, и включать его в распределение значит
 * подмешивать другой объект.
 */
export function startDistribution(candles, { monthly = 100, costRate = 0.001, minYears = 1 } = {}) {
  if (!candles?.length) return null;
  const starts = contributionBars(candles);
  const runs = [];
  for (const s of starts) {
    const r = dcaRun(candles, { startIndex: s, monthly, costRate });
    if (r && r.years >= minYears) runs.push(r);
  }
  if (!runs.length) return null;

  const mult = runs.map((r) => r.multiple).sort((a, b) => a - b);
  const ann = runs.map((r) => r.annualPct).sort((a, b) => a - b);
  const losers = runs.filter((r) => r.value < r.invested).length;

  return {
    scenarios: runs.length,
    minYears,
    multiple: {
      worst: mult[0], p25: quantile(mult, 0.25), median: quantile(mult, 0.5),
      p75: quantile(mult, 0.75), best: mult[mult.length - 1],
    },
    annualPct: {
      worst: ann[0], p25: quantile(ann, 0.25), median: quantile(ann, 0.5),
      p75: quantile(ann, 0.75), best: ann[ann.length - 1],
    },
    /** Доля стартов, на которых план через `minYears`+ всё ещё в минусе. */
    lossRate: losers / runs.length,
    runs,
  };
}

/**
 * Равновзвешенная корзина: тот же взнос, поделённый поровну между монетами.
 *
 * Считается как отдельный актив, а не как среднее готовых результатов: среднее
 * множителей и множитель среднего — разные числа, и второе описывает то, что
 * реально происходит на счёте.
 */
export function basketCandles(bySymbol) {
  const symbols = Object.keys(bySymbol || {});
  if (!symbols.length) return [];
  // Только те метки времени, что есть у всех: дырка у одной монеты иначе
  // молча переносит её вес на остальных.
  const counts = new Map();
  for (const s of symbols) {
    for (const c of bySymbol[s]) counts.set(c.time, (counts.get(c.time) || 0) + 1);
  }
  const times = [...counts.entries()]
    .filter(([, n]) => n === symbols.length).map(([t]) => t).sort((a, b) => a - b);
  if (times.length < 2) return [];

  const byTime = {};
  for (const s of symbols) byTime[s] = new Map(bySymbol[s].map((c) => [c.time, c.close]));

  // Индекс, стартующий со 100: каждая монета входит с равным весом в первый
  // момент и дальше растёт своим темпом.
  const base = {};
  for (const s of symbols) base[s] = byTime[s].get(times[0]);
  return times.map((t) => {
    let sum = 0;
    for (const s of symbols) sum += (byTime[s].get(t) / base[s]) / symbols.length;
    return { time: t, open: sum * 100, high: sum * 100, low: sum * 100, close: sum * 100, volume: 0 };
  });
}

/**
 * Сколько лет до цели при измеренной ставке — не при выдуманной.
 *
 * Берёт распределение стартов и отвечает на вопрос владельца денег: при
 * медианном сценарии, при худшем, при лучшем — когда доход достигнет цели.
 */
export function yearsToIncome({ monthly, annualPct, incomePerYear }) {
  if (!(monthly > 0) || !(incomePerYear > 0)) return null;
  const m = Math.pow(1 + annualPct / 100, 1 / 12) - 1;
  // При неположительной ставке капитал имеет потолок: взнос, делённый на
  // скорость убыли. Если цель выше потолка, время её не достанет никогда.
  const target = incomePerYear / (annualPct / 100);
  if (!(annualPct > 0)) return { years: Infinity, reachable: false, ceiling: m < 0 ? monthly / Math.abs(m) : Infinity };
  if (Math.abs(m) < 1e-12) return { years: Infinity, reachable: false, ceiling: Infinity };

  const months = Math.log(1 + (target * m) / monthly) / Math.log(1 + m);
  if (!Number.isFinite(months) || months < 0) return { years: Infinity, reachable: false, ceiling: Infinity };
  return { years: months / 12, months, reachable: true, capitalNeeded: target };
}

/**
 * Измеренный результат стратегии, переведённый в годовую ставку.
 *
 * Сравнивать «−57R» с «×2.3 за четыре года» напрямую нельзя: это разные
 * единицы на разных схемах внесения денег. Общий знаменатель — годовая ставка,
 * и она же напрямую подставляется в `yearsToIncome`, где стоит цель.
 *
 * Модель: на каждую сделку рискуется `riskPerTrade` от ТЕКУЩЕГО счёта, поэтому
 * результат мультипликативен. Точный расчёт требует каждой сделки по
 * отдельности; по одной лишь сумме R получается приближение, и оно завышает
 * результат, потому что не видит просадок внутри пути. Для отрицательной суммы
 * R это означает, что реальный итог ХУЖЕ посчитанного, — то есть ошибка
 * направлена в безопасную сторону и вывод не смягчает.
 */
export function annualFromR({ totalR, years, riskPerTrade = 0.01 }) {
  if (!(years > 0) || !Number.isFinite(totalR)) return null;
  const growth = Math.pow(1 + riskPerTrade, totalR);
  if (!(growth > 0)) return null;               // счёт обнулён
  return {
    riskPerTrade,
    growth,
    annualPct: (Math.pow(growth, 1 / years) - 1) * 100,
    approximate: true,
  };
}

/** Вердикт словами. */
export function describeDca(dist, { label = 'актив' } = {}) {
  if (!dist) return 'Данных не хватило, чтобы построить распределение стартов.';
  const n2 = (v) => (v == null || !Number.isFinite(v) ? '—' : v.toFixed(2));
  const pc = (v) => (v == null || !Number.isFinite(v) ? '—' : `${(v * 100).toFixed(0)}%`);

  const { multiple: m, annualPct: a } = dist;
  return `${label}: ${dist.scenarios} возможных дат старта с горизонтом от ` +
    `${dist.minYears} года. Медианный сценарий превращает вложенное в ` +
    `**×${n2(m.median)}** (${n2(a.median)}% годовых), худший — в ×${n2(m.worst)} ` +
    `(${n2(a.worst)}%), лучший — в ×${n2(m.best)} (${n2(a.best)}%). ` +
    `В минусе спустя ${dist.minYears}+ лет остаются **${pc(dist.lossRate)}** стартов. ` +
    'Худший столбец здесь важнее медианного: начинающий не знает, в какую точку ' +
    'истории он попал.';
}
