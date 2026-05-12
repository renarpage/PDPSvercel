/**
 * lib/session.js
 * Cookie sessions backed by Upstash Redis.
 *
 * API publik:
 *   getSession(req)          → { sessionId, data }
 *   saveSession(res, id, data, ttl)
 *   destroySession(res, id)
 */

const crypto  = require('crypto');
const redis   = require('./redis');

const COOKIE_NAME  = 'sid';
const SESSION_TTL  = 60 * 60 * 6; // 6 jam (dalam detik)
const KEY_PREFIX   = 'sess:';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(
    raw.split(';').map(s => s.trim().split('=').map(decodeURIComponent))
  );
}

function setCookieHeader(res, name, value, opts = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (opts.maxAge) parts.push(`Max-Age=${opts.maxAge}`);
  if (opts.httpOnly) parts.push('HttpOnly');
  if (opts.sameSite) parts.push(`SameSite=${opts.sameSite}`);
  if (opts.secure)   parts.push('Secure');
  if (opts.path)     parts.push(`Path=${opts.path}`);
  const existing = res.getHeader('Set-Cookie') || [];
  const arr = Array.isArray(existing) ? existing : [existing];
  res.setHeader('Set-Cookie', [...arr, parts.join('; ')]);
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Baca session dari cookie → Redis.
 * Mengembalikan { sessionId, data } — data = {} jika belum ada.
 */
async function getSession(req) {
  const cookies   = parseCookies(req);
  const sessionId = cookies[COOKIE_NAME];

  if (!sessionId) return { sessionId: null, data: {} };

  const data = await redis.get(`${KEY_PREFIX}${sessionId}`);
  return { sessionId, data: data || {} };
}

/**
 * Simpan session ke Redis dan tulis cookie ke response.
 * Jika sessionId null, buat ID baru.
 */
async function saveSession(res, sessionId, data, ttl = SESSION_TTL) {
  const id = sessionId || crypto.randomBytes(32).toString('hex');
  await redis.set(`${KEY_PREFIX}${id}`, data, { ex: ttl });

  setCookieHeader(res, COOKIE_NAME, id, {
    maxAge  : ttl,
    httpOnly: true,
    sameSite: 'Lax',
    path    : '/',
    // secure : true,  // aktifkan di production HTTPS
  });

  return id;
}

/**
 * Hapus session dari Redis dan clear cookie.
 */
async function destroySession(res, sessionId) {
  if (sessionId) {
    await redis.del(`${KEY_PREFIX}${sessionId}`);
  }
  setCookieHeader(res, COOKIE_NAME, '', {
    maxAge  : 0,
    httpOnly: true,
    sameSite: 'Lax',
    path    : '/',
  });
}

module.exports = { getSession, saveSession, destroySession };