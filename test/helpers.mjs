/** Shared helpers for the end-to-end suites (cookie-session auth). */

export const SESSION_COOKIE = 'qdesk_session';

/** Pull the session cookie out of a response, ready to send back as a header. */
export function cookieFrom(res) {
  const raw = typeof res.headers.getSetCookie === 'function'
    ? res.headers.getSetCookie()
    : [res.headers.get('set-cookie')].filter(Boolean);
  for (const c of raw) {
    const m = new RegExp(`${SESSION_COOKIE}=([^;]*)`).exec(c);
    if (m && m[1]) return `${SESSION_COOKIE}=${m[1]}`;
  }
  return null;
}

/** fetch() with JSON body and an optional session cookie. */
export function req(base, path, { method = 'GET', body, cookie, redirect } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  return fetch(base + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: redirect || 'follow',
  });
}

/** First-run: create the team lead and return { operator, cookie }. */
export async function setupLead(base, { name, email, password }) {
  const res = await req(base, '/api/auth/setup', { method: 'POST', body: { name, email, password } });
  const data = await res.json();
  return { ...data, cookie: cookieFrom(res), status: res.status };
}

/** Sign in and return { operator, cookie, status }. */
export async function login(base, email, password) {
  const res = await req(base, '/api/auth/login', { method: 'POST', body: { email, password } });
  const data = await res.json().catch(() => ({}));
  return { ...data, cookie: cookieFrom(res), status: res.status };
}

/** Socket.IO connection options carrying the session cookie. */
export function socketAuth(cookie) {
  return { auth: { role: 'operator' }, extraHeaders: cookie ? { Cookie: cookie } : {} };
}

export const wait = (ms) => new Promise((r) => setTimeout(r, ms));

export function makeChecker(results) {
  return (name, cond) => {
    results.push([name, cond]);
    console.log((cond ? '  ✅' : '  ❌') + ' ' + name);
  };
}
