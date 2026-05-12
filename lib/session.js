/**
 * lib/session.js
 * Cookie sessions backed by Upstash Redis.
 *
 * API publik:
 *   getSession(req)            → data object langsung
 *   saveSession(req, res, data, ttl)
 *   clearSession(req, res)     → alias destroySession
 *   destroySession(req, res)
 */

const crypto = require('crypto');
const redis  = require('./redis');

const COOKIE_NAME = 'sid';
const SESSION_TTL = 60 * 60 * 6; // 6 jam
const KEY_PREFIX  = 'sess:';

// ── Cookie helpers ────────────────────────────────────────────────────────────

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  const result = {};
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k) result[k.trim()] = decodeURIComponent(v.join('='));
  }
  return result;
}

function setCookieHeader(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge != null) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly)       parts.push('HttpOnly');
  if (opts.sameSite)       parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure)         parts.push('Secure');
  parts.push('Path=/');

  const existing = res.getHeader('Set-Cookie') || [];
  const arr = Array.isArray(existing) ? existing : [existing];
  res.setHeader('Set-Cookie', [...arr.filter(Boolean), parts.join('; ')]);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Baca session dari cookie → Redis.
 * Mengembalikan data object langsung.
 * sessionId disimpan sebagai properti tersembunyi _sid di object.
 */
async function getSession(req) {
  const cookies   = parseCookies(req);
  const sessionId = cookies[COOKIE_NAME];

  if (!sessionId) {
    const obj = {};
    Object.defineProperty(obj, '_sid', { value: null, writable: true, enumerable: false });
    return obj;
  }

  const data = await redis.get(`${KEY_PREFIX}${sessionId}`);
  const obj  = data || {};
  Object.defineProperty(obj, '_sid', { value: sessionId, writable: true, enumerable: false });
  return obj;
}

/**
 * Simpan session ke Redis dan tulis cookie ke response.
 * Signature: saveSession(req, res, data, ttl?)
 */
async function saveSession(req, res, data, ttl = SESSION_TTL) {
  let id = data._sid;
  if (!id) {
    id = crypto.randomBytes(32).toString('hex');
    try {
      Object.defineProperty(data, '_sid', { value: id, writable: true, enumerable: false });
    } catch (_) {}
  }

  await redis.set(`${KEY_PREFIX}${id}`, data, { ex: ttl });

  setCookieHeader(res, COOKIE_NAME, id, {
    maxAge  : ttl,
    httpOnly: true,
    sameSite: 'Lax',
  });

  return id;
}

/**
 * Hapus session dari Redis dan clear cookie.
 */
async function destroySession(req, res) {
  const cookies   = parseCookies(req);
  const sessionId = cookies[COOKIE_NAME];
  if (sessionId) {
    await redis.del(`${KEY_PREFIX}${sessionId}`);
  }
  setCookieHeader(res, COOKIE_NAME, '', { maxAge: 0, httpOnly: true, sameSite: 'Lax' });
}

// clearSession adalah alias dari destroySession (kompatibel dengan [action].js)
const clearSession = destroySession;

module.exports = { getSession, saveSession, destroySession, clearSession };
