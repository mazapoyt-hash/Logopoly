/**
 * The goal tab.
 *
 * A module of its own rather than another function inside app.js, for one
 * reason: it shares `goal.js` with the test suite. The arithmetic on this page
 * is the same code that is checked against a month-by-month simulation in
 * `test/goal.test.mjs`, so a number shown here cannot quietly disagree with a
 * number this project claims to have verified.
 *
 * It also needs nothing from the exchange, nothing from a scan, and no
 * workflow. Everything below is computed in the reader's browser from three
 * inputs — which means the table can be argued with by changing a number rather
 * than by trusting whoever wrote it down.
 */
import {
  futureValue, ceilingAt, capitalForIncome, monthsToCapital, monthsToIncome,
  requiredMonthly, requiredReturn, volatilityDrag,
} from './goal.js';

const $ = (s) => document.querySelector(s);

const money = (v) => (v == null || !Number.isFinite(v) ? '—'
  : v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1e3 ? `$${Math.round(v).toLocaleString('ru-RU')}`
      : `$${v.toFixed(0)}`);

const years = (months) => (months == null ? 'никогда'
  : months / 12 >= 100 ? '100+ лет'
    : `${(months / 12).toFixed(1)} лет`);

const pct = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}%`);

/**
 * Rates worth asking about, each labelled with what it would actually be.
 *
 * The labels are the point. "30%" on its own is an abstraction; "лучше почти
 * любого хедж-фонда" is the same number with its price attached, and the whole
 * risk of a page like this is that a reader picks a rate off a slider without
 * noticing what claiming it would mean.
 */
const RATES = [
  { pct: -10, label: 'то, что измерено у сигнальной стратегии' },
  { pct: 0, label: 'просто откладывать, ничего не делая' },
  { pct: 5, label: 'облигации' },
  { pct: 10, label: 'индекс акций, историческое среднее' },
  { pct: 15, label: 'заметно лучше индекса' },
  { pct: 20, label: 'уровень очень хорошего управляющего' },
  { pct: 30, label: 'лучше почти любого хедж-фонда' },
  { pct: 50, label: 'единицы в мире, и недолго' },
  { pct: 100, label: 'удвоение каждый год подряд' },
];

const CONTRIBUTIONS = [100, 250, 500, 1000, 2500, 5000];

function rateTable(monthly, income) {
  const rows = RATES.map((r) => {
    const target = capitalForIncome({ incomePerYear: income, annualPct: r.pct });
    const months = monthsToIncome({ monthly, annualPct: r.pct, incomePerYear: income });
    const ceiling = ceilingAt(r.pct, monthly);
    const cls = months == null ? 'down' : months / 12 <= 15 ? 'up' : '';
    return `
      <tr>
        <td class="num"><b>${r.pct}%</b></td>
        <td class="muted small">${r.label}</td>
        <td class="num">${target == null ? (ceiling ? `потолок ${money(ceiling)}` : '—') : money(target)}</td>
        <td class="num ${cls}">${years(months)}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th class="num">Годовых</th><th>Что это значит</th>
          <th class="num">Нужен капитал</th><th class="num">Лет при ваших взносах</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function contributionTable(income) {
  const rows = CONTRIBUTIONS.map((amount) => {
    const m = monthsToIncome({ monthly: amount, annualPct: 10, incomePerYear: income });
    return `
      <tr>
        <td class="num"><b>${money(amount)}</b>/мес</td>
        <td class="num">${money(amount * 12)}/год</td>
        <td class="num">${years(m)}</td>
        <td class="num">${money(futureValue({ monthly: amount, annualPct: 10, months: 240 }))}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th class="num">Взнос</th><th class="num">В год</th>
          <th class="num">Лет до цели при 10%</th><th class="num">Капитал за 20 лет</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * What rate each horizon demands — the same question asked backwards.
 *
 * Read forwards the table says "at this rate, this long". Read backwards it
 * says "to be done by then, you need this", and the second reading is the one
 * that makes an impossible plan look impossible: a five-year horizon on $100 a
 * month demands about 98% a year, sustained, which is not a target but a wish.
 */
function horizonTable(monthly, income) {
  const rows = [5, 10, 15, 20, 30, 40].map((y) => {
    const need = requiredReturn({ monthly, months: y * 12, incomePerYear: income });
    const cls = need == null ? 'down' : need > 30 ? 'down' : need > 15 ? '' : 'up';
    return `
      <tr>
        <td class="num"><b>${y} лет</b></td>
        <td class="num ${cls}">${need == null ? 'невозможно' : pct(need)}</td>
        <td class="muted small">${need == null ? 'даже 1000% годовых не хватит'
      : need > 50 ? 'такого не бывает устойчиво'
        : need > 30 ? 'лучше почти любого хедж-фонда'
          : need > 15 ? 'нужен настоящий, редкий навык'
            : 'в пределах того, что даёт рынок'}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th class="num">Успеть за</th><th class="num">Нужно годовых</th>
          <th>Что это за ставка</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

/**
 * The cost of reaching for a big number.
 *
 * Compounding grows the geometric mean, and the gap to the arithmetic one is
 * about half the variance. So the swing that comes with chasing 50% a year is
 * subtracted from the very compounding it was supposed to feed — and past a
 * point the pot shrinks in the long run despite a positive average every year.
 */
function dragTable() {
  const rows = [[25, 40], [25, 60], [25, 100], [50, 60], [50, 80], [50, 120]].map(([a, s]) => {
    const d = volatilityDrag({ arithmeticPct: a, sdPct: s });
    return `
      <tr>
        <td class="num">+${a}%</td>
        <td class="num">${s}%</td>
        <td class="num ${d.compoundsNegative ? 'down' : 'up'}">${pct(d.geometricPct)}</td>
        <td class="muted small">${d.compoundsNegative
      ? 'в долгую капитал тает, несмотря на плюс в среднем' : ''}</td>
      </tr>`;
  }).join('');

  return `
    <div class="table-wrap">
      <table>
        <thead><tr><th class="num">Среднее за год</th><th class="num">Разброс</th>
          <th class="num">Реально компаундится</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function verdict(monthly, income) {
  const at10 = monthsToIncome({ monthly, annualPct: 10, incomePerYear: income });
  const pot = monthsToCapital({ monthly, annualPct: 10, target: income });
  const need20 = requiredReturn({ monthly, months: 240, incomePerYear: income });
  const ratio = income / (monthly * 12);

  return `
    <div class="warn-banner">
      <b>Доход ${money(income)} в год — это ${ratio.toFixed(0)}× от того, что вы вносите за год.</b>
      Такое соотношение не берётся ставкой: его берёт капитал, а капитал растёт
      из взносов и времени. При ${money(monthly)}/мес и реалистичных 10% годовых
      цель приходит через <b>${years(at10)}</b>. Чтобы успеть за 20 лет,
      нужно ${need20 == null ? 'больше, чем бывает' : `<b>${pct(need20)}</b> годовых`}
      — устойчиво, каждый год.
    </div>
    <div class="ok-banner">
      <b>Но половина цели куда ближе, чем целое.</b> Накопить сам капитал
      ${money(income)} при тех же ${money(monthly)}/мес и 10% — это
      <b>${years(pot)}</b>, а не ${years(at10)}. Разница в том, что «иметь
      ${money(income)}» и «получать ${money(income)} каждый год» — это две очень
      разные задачи, и вторая больше первой примерно в десять раз.
    </div>`;
}

function render() {
  const monthly = Math.max(1, Number($('#goalMonthly')?.value) || 100);
  const income = Math.max(1, Number($('#goalIncome')?.value) || 50000);

  $('#goalVerdict').innerHTML = verdict(monthly, income);
  $('#goalRateBox').innerHTML = rateTable(monthly, income);
  $('#goalHorizonBox').innerHTML = horizonTable(monthly, income);
  $('#goalContributionBox').innerHTML = contributionTable(income);
  $('#goalDragBox').innerHTML = dragTable();

  const need = requiredMonthly({
    annualPct: 10, months: 240,
    target: capitalForIncome({ incomePerYear: income, annualPct: 10 }),
  });
  $('#goalMeta').textContent =
    `Считается в браузере, здесь и сейчас: взнос в конце каждого месяца, ` +
    `всё реинвестируется, ничего не выводится. Чтобы прийти к цели за 20 лет ` +
    `при 10% годовых, вносить нужно ${money(need)} в месяц.`;
}

export function mountGoal() {
  if (!$('#goalVerdict')) return;
  for (const id of ['#goalMonthly', '#goalIncome']) {
    $(id)?.addEventListener('input', render);
  }
  render();
}

document.addEventListener('DOMContentLoaded', mountGoal);
// The tab may be opened before or after DOMContentLoaded depending on cache;
// mounting on click as well keeps it correct either way, and render() is pure.
document.querySelector('.tab[data-view="goal"]')?.addEventListener('click', mountGoal);
