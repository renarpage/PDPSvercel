/**
 * lib/redis.js
 * Upstash Redis wrapper + in-memory fallback (menggantikan Vercel KV)
 *
 * Env vars yang dibutuhkan (dari dashboard Upstash):
 *   UPSTASH_REDIS_REST_URL   — https://xxx.upstash.io
 *   UPSTASH_REDIS_REST_TOKEN — AXxx...
 */

// ── in-memory fallback (untuk local dev tanpa Upstash) ──────────────────────
const memStore = new Map(); // key → { value, expiresAt }

function memGet(key) {
  const entry = memStore.get(key);
  if (!entry) return null;
  if (entry.expiresAt && Date.now() > entry.expiresAt) {
    memStore.delete(key);
    return null;
  }
  return entry.value;
}

function memSet(key, value, ttlSeconds) {
  memStore.set(key, {
    value,
    expiresAt: ttlSeconds ? Date.now() + ttlSeconds * 1000 : null,
  });
}

function memDel(key) {
  memStore.delete(key);
}

// ── Upstash REST helper ──────────────────────────────────────────────────────
const BASE_URL   = process.env.UPSTASH_REDIS_REST_URL;
const AUTH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const hasUpstash = !!(BASE_URL && AUTH_TOKEN);

async function upstashCommand(...args) {
  const res = await fetch(`${BASE_URL}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(args),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Upstash error ${res.status}: ${text}`);
  }
  const json = await res.json();
  return json.result;
}

// ── Public API (drop-in pengganti @vercel/kv) ────────────────────────────────

/**
 * Ambil nilai dari Redis.
 * @param {string} key
 * @returns {Promise<any|null>}
 */
async function get(key) {
  if (!hasUpstash) {
    const raw = memGet(key);
    return raw === null ? null : JSON.parse(raw);
  }
  const raw = await upstashCommand('GET', key);
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); } catch { return raw; }
}

/**
 * Simpan nilai ke Redis.
 * @param {string} key
 * @param {any} value
 * @param {{ ex?: number }} [opts]  ex = TTL dalam detik
 */
async function set(key, value, opts = {}) {
  const serialized = JSON.stringify(value);
  if (!hasUpstash) {
    memSet(key, serialized, opts.ex);
    return;
  }
  const cmd = ['SET', key, serialized];
  if (opts.ex) { cmd.push('EX', opts.ex); }
  await upstashCommand(...cmd);
}

/**
 * Hapus key dari Redis.
 * @param {string} key
 */
async function del(key) {
  if (!hasUpstash) { memDel(key); return; }
  await upstashCommand('DEL', key);
}

/**
 * Cek apakah key ada.
 * @param {string} key
 * @returns {Promise<boolean>}
 */
async function exists(key) {
  if (!hasUpstash) return memGet(key) !== null;
  const result = await upstashCommand('EXISTS', key);
  return result === 1;
}

/**
 * Set TTL (expire) pada key yang sudah ada.
 * @param {string} key
 * @param {number} seconds
 */
async function expire(key, seconds) {
  if (!hasUpstash) {
    const raw = memGet(key);
    if (raw !== null) memSet(key, raw, seconds);
    return;
  }
  await upstashCommand('EXPIRE', key, seconds);
}

if (!hasUpstash) {
  console.warn(
    '[redis] UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN tidak ditemukan' +
    ' — menggunakan in-memory store (hanya untuk development).'
  );
}

module.exports = { get, set, del, exists, expire };
