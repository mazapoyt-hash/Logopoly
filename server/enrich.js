/**
 * Lightweight, dependency-free enrichment helpers: parse the User-Agent into
 * browser / OS / device, and derive a traffic source label from referrer + UTM.
 * (No external geo-IP call here — that can be plugged in later; see geoFromIp.)
 */

export function parseUserAgent(ua = '') {
  const s = ua || '';
  let browser = 'Unknown';
  let os = 'Unknown';
  let device = 'desktop';

  // OS
  if (/Windows NT 10/.test(s)) os = 'Windows 10/11';
  else if (/Windows NT/.test(s)) os = 'Windows';
  else if (/iPhone|iPad|iPod/.test(s)) os = 'iOS';
  else if (/Android/.test(s)) os = 'Android';
  else if (/Mac OS X/.test(s)) os = 'macOS';
  else if (/Linux/.test(s)) os = 'Linux';

  // Browser (order matters)
  if (/YaBrowser/.test(s)) browser = 'Yandex Browser';
  else if (/Edg\//.test(s)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(s)) browser = 'Opera';
  else if (/Chrome\//.test(s)) browser = 'Chrome';
  else if (/Firefox\//.test(s)) browser = 'Firefox';
  else if (/Safari\//.test(s)) browser = 'Safari';

  // Device
  if (/iPad|Tablet/.test(s)) device = 'tablet';
  else if (/Mobi|iPhone|Android.+Mobile/.test(s)) device = 'mobile';

  return { browser, os, device };
}

const SEARCH_ENGINES = [
  { re: /yandex\./i, name: 'Яндекс' },
  { re: /google\./i, name: 'Google' },
  { re: /bing\./i, name: 'Bing' },
  { re: /duckduckgo\./i, name: 'DuckDuckGo' },
  { re: /mail\.ru/i, name: 'Mail.ru' },
];

const SOCIALS = [
  { re: /vk\.com/i, name: 'ВКонтакте' },
  { re: /t\.me|telegram/i, name: 'Telegram' },
  { re: /instagram\.com/i, name: 'Instagram' },
  { re: /facebook\.com|fb\.com/i, name: 'Facebook' },
  { re: /ok\.ru/i, name: 'Одноклассники' },
  { re: /youtube\.com/i, name: 'YouTube' },
];

/**
 * Derive a human-readable source label and a raw search query (if any) from
 * the referrer URL and UTM params.
 */
export function deriveSource({ referrer, utm } = {}) {
  const u = utm || {};
  if (u.utm_source) {
    const medium = u.utm_medium ? ` / ${u.utm_medium}` : '';
    const campaign = u.utm_campaign ? ` (${u.utm_campaign})` : '';
    return { source: `${u.utm_source}${medium}${campaign}`, searchQuery: u.utm_term || null };
  }
  if (!referrer) return { source: 'Прямой заход', searchQuery: null };

  for (const eng of SEARCH_ENGINES) {
    if (eng.re.test(referrer)) {
      let q = null;
      try {
        const url = new URL(referrer);
        q = url.searchParams.get('text') || url.searchParams.get('q') || null;
      } catch {}
      return { source: `Поиск — ${eng.name}`, searchQuery: q };
    }
  }
  for (const soc of SOCIALS) {
    if (soc.re.test(referrer)) return { source: `Соцсеть — ${soc.name}`, searchQuery: null };
  }
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    return { source: `Переход — ${host}`, searchQuery: null };
  } catch {
    return { source: 'Переход по ссылке', searchQuery: null };
  }
}

/**
 * Best-effort geo from IP. Kept synchronous & offline for now: private / local
 * addresses return a friendly placeholder. Swap this for a real geo-IP lookup
 * (MaxmindDB, ip-api, etc.) without touching callers.
 */
export function geoFromIp(ip) {
  if (!ip || ip === '::1' || ip.startsWith('127.') || ip.startsWith('192.168.') || ip.startsWith('10.') || ip.startsWith('::ffff:127')) {
    return { country: 'Локальная сеть', city: 'localhost' };
  }
  return { country: null, city: null };
}

export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || null;
}
