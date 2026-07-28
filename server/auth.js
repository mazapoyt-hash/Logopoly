/**
 * Password hashing and session cookies for the operator area.
 *
 * Uses Node's built-in scrypt — no native dependency to build, and it is a
 * memory-hard KDF suitable for storing passwords.
 */
import crypto from 'node:crypto';

export const SESSION_COOKIE = 'qdesk_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

/* ------------------------------ Passwords ----------------------------- */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `scrypt$${salt}$${key}`;
}

export function verifyPassword(password, stored) {
  if (!stored || typeof stored !== 'string') return false;
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt' || !salt || !key) return false;
  let known;
  try { known = Buffer.from(key, 'hex'); } catch { return false; }
  const calc = crypto.scryptSync(String(password), salt, 64);
  return known.length === calc.length && crypto.timingSafeEqual(known, calc);
}

/** Minimum bar for a password; returns an error string or null. */
export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < 8) {
    return 'Пароль должен быть не короче 8 символов';
  }
  return null;
}

export function newSessionToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/* ------------------------------- Cookies ------------------------------ */
export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (!name) continue;
    try { out[name] = decodeURIComponent(part.slice(eq + 1).trim()); } catch { /* keep going */ }
  }
  return out;
}

/** Mark the cookie Secure when the request actually arrived over HTTPS. */
function isSecure(req) {
  if (process.env.QDESK_FORCE_SECURE_COOKIE === '1') return true;
  const proto = req.get?.('x-forwarded-proto');
  if (proto) return String(proto).split(',')[0].trim() === 'https';
  return !!req.secure;
}

export function setSessionCookie(req, res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

export function clearSessionCookie(req, res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (isSecure(req)) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}
