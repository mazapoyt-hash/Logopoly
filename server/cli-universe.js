/**
 * Universe funnel: why the tradable list is the size it is.
 *
 * WHY THIS EXISTS
 *
 * The first live cross-sectional run died on "слишком узкая вселенная" with
 * seven coins where forty were asked for. That number was not a cross-section
 * problem. `status.json` from the same period says `universe.size: 7` with
 * `screened: []` — seven coins came back from the exchange request itself,
 * before a single filter of ours ran, and the scan has been quietly working on
 * between 7 and 15 coins for days.
 *
 * On Binance spot, hundreds of pairs turn over more than $50M a day. Seven is
 * not a market fact, so something between the request and `selectUniverse` is
 * losing rows — and every measurement in this project rests on whatever that
 * something is.
 *
 * The sandbox this was written in cannot reach Binance at all (451 from the
 * egress allowlist), so guessing was the only alternative to measuring, and
 * guessing is what cost three runs the last time a host misbehaved.
 *
 * So this asks each host directly and prints the funnel stage by stage: bytes
 * received, rows parsed, rows quoted in USDT, rows surviving each exclusion,
 * rows above the floor. Whichever stage collapses is the bug, and no
 * interpretation is needed to see it.
 *
 * Deliberately dumb, like cli-probe: no failover, no retries, no reuse of the
 * adapter's own request path — because the adapter is a suspect here, and a
 * diagnostic that shares code with its suspect can hide the defect it exists
 * to find.
 */
import fs from 'node:fs';

import { selectUniverse } from './sources/binance.js';

const TIMEOUT_MS = Number(process.env.COINSCOPE_PROBE_TIMEOUT || 20000);
const FLOOR = Number(process.env.COINSCOPE_MIN_VOLUME || 50e6);
const LIMIT = Number(process.env.COINSCOPE_UNIVERSE || 40);

const HOSTS = [
  'https://api.binance.com',
  'https://data-api.binance.vision',
  'https://api-gcp.binance.com',
  'https://api1.binance.com',
];

/** Same exclusions selectUniverse applies, kept here to count them separately. */
const STABLE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|GBP|AEUR|USD1)USDT$/;
const LEVERAGED = /(UP|DOWN|BULL|BEAR)USDT$/;

const usd = (v) => (!Number.isFinite(v) ? '—'
  : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B`
    : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M`
      : `$${(v / 1e3).toFixed(0)}K`);

async function ask(host, path) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await fetch(host + path, { signal: ctrl.signal });
    const body = await res.text();
    return { host, path, status: res.status, bytes: body.length, body, ms: Date.now() - started };
  } catch (err) {
    return { host, path, status: null, bytes: 0, body: '', ms: Date.now() - started, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The funnel for one payload.
 *
 * Every stage is counted separately even where `selectUniverse` folds them
 * together, because "seven coins" has completely different causes depending on
 * whether the array arrived with seven entries or with three thousand of which
 * seven cleared the floor.
 */
function funnel(rows) {
  const usdt = rows.filter((r) => typeof r?.symbol === 'string' && r.symbol.endsWith('USDT'));
  const notStable = usdt.filter((r) => !STABLE.test(r.symbol));
  const notLeveraged = notStable.filter((r) => !LEVERAGED.test(r.symbol));
  const withVolume = notLeveraged.filter((r) => Number.isFinite(Number(r.quoteVolume)));
  const sorted = [...withVolume]
    .map((r) => ({ symbol: r.symbol, quoteVolume: Number(r.quoteVolume) }))
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const atLeast = (floor) => sorted.filter((r) => r.quoteVolume >= floor).length;

  return {
    rows: rows.length,
    usdt: usdt.length,
    notStable: notStable.length,
    notLeveraged: notLeveraged.length,
    withVolume: withVolume.length,
    aboveFloor: atLeast(FLOOR),
    above1M: atLeast(1e6),
    above10M: atLeast(10e6),
    above100M: atLeast(100e6),
    top: sorted.slice(0, 12),
    /*
     * The fields actually present on a row. If the host answers with a MINI
     * ticker, `quoteVolume` may simply not be there — and Number(undefined) is
     * NaN, which the floor filter drops silently. That would look exactly like
     * a thin market.
     */
    fields: rows.length ? Object.keys(rows[0]) : [],
  };
}

async function main() {
  const out = [];
  out.push('## Вселенная: куда деваются монеты');
  out.push('');
  out.push(`Порог оборота ${usd(FLOOR)} за сутки, запрашивается ${LIMIT} монет.`);
  out.push('');

  const results = [];
  for (const host of HOSTS) {
    const res = await ask(host, '/api/v3/ticker/24hr');
    let rows = null;
    let parseError = null;
    if (res.status === 200 && res.body.trim()) {
      try {
        const data = JSON.parse(res.body);
        rows = Array.isArray(data) ? data : null;
        if (!rows) parseError = `ответ не массив, а ${typeof data}`;
      } catch (err) {
        parseError = err.message;
      }
    }
    const f = rows ? funnel(rows) : null;
    results.push({ res, rows, parseError, funnel: f });

    console.log(`${host}: ${res.status ?? 'нет ответа'} ` +
      `${res.bytes} байт за ${res.ms}мс` +
      (f ? ` → ${f.rows} строк, ${f.aboveFloor} выше порога` : '') +
      (res.error ? ` (${res.error})` : '') +
      (parseError ? ` (${parseError})` : ''));
  }

  out.push('| Хост | Статус | Байт | Строк | USDT | не стейбл | не плечевые | с оборотом | выше порога |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const { res, funnel: f } of results) {
    const h = res.host.replace('https://', '');
    if (!f) {
      out.push(`| ${h} | ${res.status ?? '—'} | ${res.bytes} | — | — | — | — | — | — |`);
      continue;
    }
    out.push(`| ${h} | ${res.status} | ${res.bytes} | ${f.rows} | ${f.usdt} | ` +
      `${f.notStable} | ${f.notLeveraged} | ${f.withVolume} | **${f.aboveFloor}** |`);
  }
  out.push('');

  const best = results.find((r) => r.funnel);
  if (!best) {
    out.push('Ни один хост не вернул разбираемый список. Смотреть надо на статусы выше: ' +
      'вселенная в проекте берётся ровно отсюда.');
  } else {
    const f = best.funnel;
    out.push(`### Что вернул ${best.res.host.replace('https://', '')}`);
    out.push('');
    out.push(`Поля строки: \`${f.fields.join('`, `')}\``);
    out.push('');
    out.push('Распределение по обороту (пар в USDT, после исключений):');
    out.push('');
    out.push('| Порог | Пар |');
    out.push('|---|---:|');
    out.push(`| ≥ $1M | ${f.above1M} |`);
    out.push(`| ≥ $10M | ${f.above10M} |`);
    out.push(`| ≥ $50M | ${f.aboveFloor} |`);
    out.push(`| ≥ $100M | ${f.above100M} |`);
    out.push('');
    out.push('Верх по обороту:');
    out.push('');
    out.push('| Монета | Оборот за 24ч |');
    out.push('|---|---:|');
    for (const r of f.top) out.push(`| ${r.symbol} | ${usd(r.quoteVolume)} |`);
    out.push('');

    /*
     * The two readings, stated plainly so the run answers rather than invites
     * another round of guessing. A short array and a full array that thins out
     * at the floor are different bugs with different fixes.
     */
    if (f.rows < 500) {
      out.push(`**Массив короткий: ${f.rows} строк.** Биржа отдаёт тысячи пар, значит ` +
        'обрезается сам ответ, а не наши фильтры. Чинить надо запрос, а не порог.');
    } else if (f.aboveFloor < 30) {
      out.push(`**Массив полный (${f.rows} строк), но выше порога только ${f.aboveFloor}.** ` +
        'Тогда дело в самом пороге или в поле оборота — сравните распределение выше ' +
        'с тем, что видно на бирже глазами.');
    } else {
      out.push(`**Здесь порог проходят ${f.aboveFloor} пар.** Если скан при этом работает ` +
        'на семи, расходится не запрос, а то, что с ответом делают дальше.');
    }
    out.push('');

    // The adapter's own selection, for comparison against the funnel above.
    const picked = selectUniverse(best.rows, { limit: LIMIT, minQuoteVolume: FLOOR });
    out.push('Через `selectUniverse` проходит: ' + `**${picked.length}** монет` +
      (picked.length ? ` — ${picked.slice(0, 10).map((p) => p.symbol).join(', ')}…` : '') + '.');
  }

  const text = out.join('\n');
  console.log('\n' + text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }
}

if (/cli-universe\.js$/.test(process.argv[1] || '')) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
