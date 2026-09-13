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

/**
 * The same question asked of a different exchange.
 *
 * The first run of this diagnostic ruled out everything it was built to rule
 * out — the array arrived complete (3701 rows, 1.9MB, every field present) and
 * 681 pairs carried a readable turnover. Only seven cleared $50M because, on
 * that host, only seven do.
 *
 * Which raises a question the Binance side cannot answer alone: BTCUSDT at
 * $515M a day is small for the largest pair on the largest venue, and ETH
 * ranking above BTC is stranger still. Either the mirror reports a fraction of
 * the real book, or the market genuinely is this thin. `api.binance.com`
 * answers 451 from every runner, so the main host cannot arbitrate.
 *
 * A second venue can. If OKX says BTC turns over billions, the mirror
 * under-reports and the floor is fine. If OKX agrees, the floor is calibrated
 * against a market that no longer exists and has to come down — with the cost
 * model following it, because a floor and a slippage assumption are one
 * decision, not two.
 */
async function crossCheck(symbols) {
  const host = process.env.OKX_URL || 'https://www.okx.com';
  const res = await ask(host, '/api/v5/market/tickers?instType=SPOT');
  if (res.status !== 200 || !res.body.trim()) return { host, res, rows: null };
  try {
    const parsed = JSON.parse(res.body);
    const data = Array.isArray(parsed?.data) ? parsed.data : null;
    if (!data) return { host, res, rows: null, error: 'в ответе нет поля data' };
    const wanted = new Set(symbols.map((s) => `${s.replace(/USDT$/, '')}-USDT`));
    /*
     * OKX changes what `volCcy24h` means between instrument types: on a SWAP it
     * is the base currency (so turnover needs × price, which is what the
     * funding adapter does), on SPOT it is already the quote currency. Getting
     * that backwards inflates or deflates every figure by the price of the
     * coin — a unit error that produces a confident wrong answer, which is the
     * one outcome this whole diagnostic exists to avoid.
     *
     * So compute it both ways and print both. If `vol24h × last` and
     * `volCcy24h` agree, the reading is right; if they differ by roughly the
     * price, the convention is the other way round and the table says so
     * without anyone having to remember which is which.
     */
    const rows = data
      .filter((r) => wanted.has(r?.instId))
      .map((r) => {
        const last = Number(r.last);
        return {
          symbol: String(r.instId).replace('-USDT', 'USDT'),
          last,
          viaBase: Number(r.vol24h) * last,     // base volume × price
          viaQuote: Number(r.volCcy24h),        // quote volume as reported
        };
      })
      .filter((r) => Number.isFinite(r.viaBase) || Number.isFinite(r.viaQuote))
      .sort((a, b) => (b.viaBase || 0) - (a.viaBase || 0));
    return { host, res, rows };
  } catch (err) {
    return { host, res, rows: null, error: err.message };
  }
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
        'Ответ не обрезан и поля на месте, значит теряет строки не запрос и не наш отбор. ' +
        'Остаётся один вопрос: эти обороты настоящие? Ответ ниже, у второй биржи.');
    } else {
      out.push(`**Здесь порог проходят ${f.aboveFloor} пар.** Если скан при этом работает ` +
        'на семи, расходится не запрос, а то, что с ответом делают дальше.');
    }
    out.push('');

    // The adapter's own selection, for comparison against the funnel above.
    const picked = selectUniverse(best.rows, { limit: LIMIT, minQuoteVolume: FLOOR });
    out.push('Через `selectUniverse` проходит: ' + `**${picked.length}** монет` +
      (picked.length ? ` — ${picked.slice(0, 10).map((p) => p.symbol).join(', ')}…` : '') + '.');
    out.push('');

    /* ---------------------- the second opinion ------------------------- */
    const compare = f.top.slice(0, 8).map((r) => r.symbol);
    const okx = await crossCheck(compare);
    out.push('### Вторая биржа для сверки');
    out.push('');
    console.log(`okx: ${okx.res.status ?? 'нет ответа'} ${okx.res.bytes} байт` +
      (okx.rows ? ` → ${okx.rows.length} совпавших пар` : ` (${okx.error || okx.res.error || '—'})`));

    if (!okx.rows?.length) {
      out.push(`OKX не ответил разбираемым списком (${okx.res.status ?? '—'}` +
        `${okx.error ? `, ${okx.error}` : ''}). Сверить обороты не с чем, так что ` +
        'вывод о пороге пока держится на одном источнике — это слабее, чем хотелось бы.');
    } else {
      const byOkx = new Map(okx.rows.map((r) => [r.symbol, r]));
      out.push('Обороты за 24ч по тем же монетам. У OKX два поля, и смысл ' +
        '`volCcy24h` отличается для спота и свопов, поэтому показаны оба способа: ' +
        'если они сходятся — чтение верное.');
      out.push('');
      out.push('| Монета | Binance (зеркало) | OKX: объём × цена | OKX: volCcy24h | Отношение |');
      out.push('|---|---:|---:|---:|---:|');
      const ratios = [];
      for (const r of f.top.slice(0, 8)) {
        const o = byOkx.get(r.symbol);
        // Whichever OKX reading is the larger is the quote-denominated one:
        // base-denominated volume is smaller than turnover by the coin's price.
        const okxTurnover = o ? Math.max(o.viaBase || 0, o.viaQuote || 0) : null;
        const ratio = okxTurnover && r.quoteVolume > 0 ? okxTurnover / r.quoteVolume : null;
        if (ratio) ratios.push(ratio);
        out.push(`| ${r.symbol} | ${usd(r.quoteVolume)} | ${o ? usd(o.viaBase) : '—'} | ` +
          `${o ? usd(o.viaQuote) : '—'} | ${ratio ? `×${ratio.toFixed(1)}` : '—'} |`);
      }
      out.push('');

      /*
       * The verdict, and it decides what gets fixed. A mirror reporting a
       * fraction of the real book is a data-source bug; a market that is
       * genuinely this thin means the floor was calibrated against a different
       * era, and lowering it obliges the cost model to follow — a flat 0.05%
       * slippage is defensible on a pair turning over hundreds of millions and
       * fiction on one turning over two.
       */
      ratios.sort((a, b) => a - b);
      const median = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
      if (median == null) {
        out.push('Ни одной пары не совпало по названию — сверка не состоялась.');
      } else if (median > 3) {
        out.push(`**Зеркало занижает: у OKX те же пары идут в среднем в ${median.toFixed(1)} раза ` +
          'больше.** Значит рынок не тонкий, а `data-api.binance.vision` отдаёт часть книги. ' +
          'Чинить надо источник, а не порог: порог $50M откалиброван правильно.');
      } else if (median > 0.33) {
        out.push(`**Биржи согласны (медиана отношения ×${median.toFixed(1)}).** Рынок ` +
          'действительно такой тонкий, и порог $50M откалиброван под другую эпоху. ' +
          'Опускать его придётся — но вместе с моделью издержек: плоские 0.05% ' +
          'проскальзывания защитимы на паре с оборотом в сотни миллионов и выдумка ' +
          'на паре с оборотом в два. Порог и издержки — это одно решение, а не два.');
      } else {
        out.push(`**OKX показывает ещё меньше (медиана ×${median.toFixed(1)}).** ` +
          'Тогда зеркало Binance не занижает, а рынок тонкий даже сильнее, чем ' +
          'следует из первой таблицы.');
      }
    }
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
