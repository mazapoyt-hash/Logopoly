/**
 * Reachability probe: which market-data hosts answer from THIS machine.
 *
 * WHY THIS EXISTS
 *
 * Three funding runs were spent discovering, one host at a time, that the
 * derivatives APIs are geo-blocked from GitHub's runners:
 *
 *     fapi.binance.com   451  "Service unavailable from a restricted location"
 *     fapi1/2            202  empty body (the same gate, a different shape)
 *     api.bybit.com      403  "CloudFront ... block access from your country"
 *
 * while Binance SPOT answers perfectly from the same machine. Each discovery
 * cost a merge, a run and a report. Writing another adapter on a guess would
 * cost a fourth.
 *
 * So: ask every candidate once, cheaply, and print what came back. One run
 * answers "what can this environment actually reach", and only then is it worth
 * writing an adapter — against a host known to respond rather than a hoped-for
 * one.
 *
 * Deliberately dumb: no retries, no failover, no parsing beyond a snippet. Its
 * whole value is that it reports rather than interprets. A probe that tried to
 * be clever could hide the very thing it exists to reveal.
 */
import fs from 'node:fs';

const TIMEOUT_MS = Number(process.env.COINSCOPE_PROBE_TIMEOUT || 12000);

/**
 * Every host worth asking, with the cheapest endpoint each one offers.
 *
 * `need` says what the host would give us if it answered, so the table is not
 * just connectivity trivia — it says which measurement becomes possible.
 */
const TARGETS = [
  {
    group: 'контроль',
    name: 'binance spot',
    url: 'https://api.binance.com/api/v3/ping',
    need: 'свечи спота — то, на чём уже работает весь проект',
  },
  {
    group: 'контроль',
    name: 'binance spot (vision)',
    url: 'https://data-api.binance.vision/api/v3/ping',
    need: 'зеркало спота только для рыночных данных',
  },
  {
    group: 'фандинг',
    name: 'binance futures',
    url: 'https://fapi.binance.com/fapi/v1/ping',
    need: 'ставки финансирования, основной источник',
  },
  {
    group: 'фандинг',
    name: 'binance public archive',
    url: 'https://data.binance.vision/?prefix=data/futures/um/monthly/fundingRate/BTCUSDT/',
    need: 'месячные архивы фандинга — статический файловый хост, не торговый API',
  },
  {
    group: 'фандинг',
    name: 'bybit',
    url: 'https://api.bybit.com/v5/market/time',
    need: 'публичная история фандинга, те же имена символов',
  },
  {
    group: 'фандинг',
    name: 'okx',
    url: 'https://www.okx.com/api/v5/public/time',
    need: 'история фандинга, символы вида BTC-USDT-SWAP',
  },
  {
    group: 'фандинг',
    name: 'gate.io',
    url: 'https://api.gateio.ws/api/v4/spot/time',
    need: 'история фандинга по usdt-контрактам',
  },
  {
    group: 'фандинг',
    name: 'bitget',
    url: 'https://api.bitget.com/api/v2/public/time',
    need: 'история фандинга по usdt-futures',
  },
  {
    group: 'фандинг',
    name: 'deribit',
    url: 'https://www.deribit.com/api/v2/public/get_time',
    need: 'история фандинга, но вселенная узкая (в основном BTC/ETH)',
  },
  {
    group: 'фандинг',
    name: 'hyperliquid',
    url: 'https://api.hyperliquid.xyz/info',
    method: 'POST',
    body: { type: 'meta' },
    need: 'фандинг и список перпетуалов; децентрализованная площадка, без страновых правил CloudFront',
  },
];

/** One request, no retries, never throws. */
async function probe(target) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const res = await fetch(target.url, {
      method: target.method || 'GET',
      signal: ctrl.signal,
      headers: {
        accept: 'application/json,*/*',
        ...(target.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(target.body ? { body: JSON.stringify(target.body) } : {}),
    });
    const text = await res.text();
    return {
      ...target,
      ms: Date.now() - started,
      status: res.status,
      bytes: text.length,
      snippet: text.replace(/\s+/g, ' ').slice(0, 110),
      /*
       * An ok status with an empty body is NOT reachable. That exact
       * combination is what two of the failed runs hit, and counting it as a
       * success here would reproduce the original mistake inside the very tool
       * built to avoid it.
       */
      ok: res.ok && text.trim().length > 0,
    };
  } catch (err) {
    return {
      ...target, ms: Date.now() - started, status: null, bytes: null,
      snippet: err.message.slice(0, 110), ok: false,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Why a host said no — read out of the answer, never guessed from the number.
 *
 * The first version of this function asserted that any 403 was "a geo-block,
 * usually CloudFront by country". Run locally, every 403 was in fact the
 * development sandbox's own egress allowlist, and the probe stated the wrong
 * cause with complete confidence — the exact failure mode this project keeps
 * catching elsewhere. A tool built to report must not invent a cause: the body
 * is quoted when it explains itself, and otherwise the status stands alone.
 */
export function reason(r) {
  if (r.ok) return 'отвечает';
  if (r.status === null) return 'нет соединения';

  const body = (r.snippet || '').toLowerCase();
  if (/not in allowlist|egress/.test(body)) {
    return `${r.status} — блокирует не площадка, а egress-политика этой среды`;
  }
  if (/restricted location|unavailable.*location|eligibility/.test(body)) {
    return `${r.status} — площадка закрыта для этой локации`;
  }
  if (/cloudfront.*block|block access from your country/.test(body)) {
    return `${r.status} — CloudFront блокирует по стране`;
  }
  if (r.status === 429 || r.status === 418) return 'лимит запросов — возможно, пройдёт позже';
  if (r.bytes === 0) return `${r.status}, но тело пустое — шлагбаум без объяснения`;
  if (r.status >= 500) return `${r.status} на стороне площадки`;
  return `${r.status} — причина в теле ответа ниже`;
}

async function main() {
  console.log(`Зонд доступности, таймаут ${TIMEOUT_MS} мс. Запросов: ${TARGETS.length}.\n`);

  // Sequential on purpose: a parallel burst can itself trigger rate limiting,
  // and then the table would measure the probe instead of the hosts.
  const results = [];
  for (const t of TARGETS) {
    const r = await probe(t);
    results.push(r);
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.name.padEnd(24)} ${String(r.status ?? '—').padStart(4)}  ` +
      `${String(r.bytes ?? '—').padStart(6)} байт  ${r.ms} мс  ${reason(r)}`);
  }

  const out = [];
  out.push('## Зонд доступности: что видно из этой среды');
  out.push('');
  out.push('Три прогона «Сбора фандинга» ушли на то, чтобы по одному выяснить, что ' +
    'деривативные API закрыты для раннеров GitHub, тогда как спот Binance с той же машины ' +
    'отвечает прекрасно. Каждое такое открытие стоило мерджа, прогона и отчёта. Этот зонд ' +
    'спрашивает все кандидаты сразу и просто печатает ответ — дальше адаптер пишется под ' +
    'хост, который **уже ответил**, а не под предполагаемый.');
  out.push('');

  for (const group of ['контроль', 'фандинг']) {
    const rows = results.filter((r) => r.group === group);
    if (!rows.length) continue;
    out.push(`### ${group === 'контроль' ? 'Контроль: то, что точно работает' : 'Источники фандинга'}`);
    out.push('');
    out.push('| | Площадка | Статус | Тело | Время | Что это значит |');
    out.push('|---|---|---:|---:|---:|---|');
    for (const r of rows) {
      out.push(`| ${r.ok ? '✅' : '❌'} | ${r.name} | ${r.status ?? '—'} | ` +
        `${r.bytes ?? '—'} | ${r.ms} мс | ${reason(r)} |`);
    }
    out.push('');
  }

  const usable = results.filter((r) => r.ok && r.group === 'фандинг');
  const control = results.filter((r) => r.group === 'контроль');
  out.push('### Вывод');
  out.push('');

  /*
   * Read the control row first. If even Binance SPOT is closed, nothing here is
   * evidence about any exchange — it is evidence about this machine's egress
   * policy, and reporting "all venues geo-block us" would be a confident false
   * conclusion. The development sandbox is exactly such a machine.
   */
  if (!control.some((r) => r.ok)) {
    out.push('⚠️ **Контрольный хост тоже закрыт.** Спот Binance работает из GitHub Actions, ' +
      'поэтому его отказ здесь означает, что запросы режет сама среда, а не площадки. ' +
      'Никакого вывода о гео-блоках по этой таблице делать нельзя — её надо получить ' +
      'оттуда, где контроль зелёный.');
    out.push('');
  }

  if (usable.length) {
    out.push(`Доступны для фандинга: **${usable.map((r) => r.name).join(', ')}**.`);
    out.push('');
    for (const r of usable) out.push(`- **${r.name}** — ${r.need}`);
    out.push('');
    out.push('Следующий шаг — адаптер под первую из этих площадок, и только под неё: ' +
      'писать под несколько сразу значит снова платить за догадки.');
  } else {
    out.push('**Ни один источник фандинга из этой среды недоступен.** Это не баг в коде и ' +
      'не то, что лечится ещё одним адаптером: деривативные API закрыты по географии ' +
      'раннера, а спот при этом отвечает. Варианты остаются такие: запускать измерение ' +
      'не из GitHub Actions, либо признать, что ставки финансирования в этой среде ' +
      'не измеримы, и сказать это прямо вместо того, чтобы показывать пустую вкладку.');
  }
  out.push('');
  out.push('Снимки ответов (первые 110 символов) — для случая, когда статус лжёт о содержимом:');
  out.push('');
  out.push('```');
  for (const r of results) out.push(`${r.name}: ${r.snippet || '(пусто)'}`);
  out.push('```');

  const text = out.join('\n');
  console.log('\n' + text);
  if (process.env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, text + '\n');
  }

  /*
   * Exit 0 even when everything is blocked. A blocked host is a RESULT here, not
   * a failure of the probe — and a red run would suggest the tool broke rather
   * than that it answered the question.
   */
}

/*
 * Run only when invoked as the command, never on import.
 *
 * The test suite imports `reason` from this file, and without this guard that
 * import FIRED THE WHOLE PROBE — ten live requests from inside `npm test`. The
 * suite is supposed to be incapable of touching an exchange (it runs with
 * COINSCOPE_SOURCE=synthetic for exactly that reason), and a module that does
 * its work at import time quietly voids that guarantee.
 */
const invokedDirectly = process.argv[1] && /cli-probe\.js$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err.stack || err.message);
    process.exit(1);
  });
}
