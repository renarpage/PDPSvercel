/**
 * api/auth/login.js  →  POST /api/auth/login
 *
 * Authenticates against SIPDPS and stores the session cookies in KV.
 * Body: { username, password, webPassword }
 */

const axios  = require('axios');
const https  = require('https');
const { getSession, saveSession } = require('../../lib/session');

const BASE_URL = 'https://sitampan.pertanian.go.id/sipdps';

const client = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
    'Connection': 'keep-alive',
  }
});

function parseCookies(headers) {
  if (!headers) return '';
  return headers.map(c => c.split(';')[0]).join('; ');
}

function extractCsrf(html) {
  const patterns = [
    /name="_token"\s+value="([^"]+)"/,
    /name="csrf_token"\s+value="([^"]+)"/,
    /<meta\s+name="csrf-token"\s+content="([^"]+)"/i,
    /["']_token["']\s*:\s*["']([^"']+)["']/,
    /name="_token" value="([^"]+)"/,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return '';
}

function mergeAndDedupeCookies(...cookieArrays) {
  const map = new Map();
  for (const arr of cookieArrays) {
    if (!arr) continue;
    for (const c of arr) {
      const pair = c.split(';')[0];
      const [name] = pair.split('=');
      map.set(name.trim(), pair);
    }
  }
  return [...map.values()].join('; ');
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  const { username, password, webPassword } = req.body;

  if (!username || !password) {
    return res.status(400).json({ success: false, message: 'Username dan password diperlukan' });
  }

  const WEB_PASSWORD = process.env.WEB_PASSWORD;
  if (!WEB_PASSWORD) {
    return res.status(500).json({ success: false, message: 'Konfigurasi server tidak lengkap: WEB_PASSWORD belum diatur' });
  }
  if (!webPassword || webPassword !== WEB_PASSWORD) {
    return res.status(403).json({ success: false, message: 'Web password salah. Akses ditolak.' });
  }

  const debug = [];

  try {
    // STEP 1: GET login page
    debug.push('Step 1: GET login page...');
    const loginUrl = `${BASE_URL}/admin/login`;
    let pageRes;

    try {
      pageRes = await client.get(loginUrl, { maxRedirects: 10 });
    } catch (e) {
      debug.push(`Primary URL failed (${e.message}), trying /auth/login`);
      pageRes = await client.get(`${BASE_URL}/auth/login`, { maxRedirects: 10 });
    }

    const effectiveUrl = pageRes.request?.res?.responseUrl || loginUrl;
    const csrf         = extractCsrf(pageRes.data);
    const pageCookies  = pageRes.headers['set-cookie'] || [];

    debug.push(`Page status: ${pageRes.status}, effective URL: ${effectiveUrl}`);
    debug.push(`CSRF: ${csrf ? csrf.substring(0, 12) + '...' : 'NOT FOUND'}`);
    debug.push(`Page cookies: ${pageCookies.length}`);

    // STEP 2: POST login
    debug.push('Step 2: POST credentials...');
    const body = new URLSearchParams();
    body.append('username', username);
    body.append('email', username);
    body.append('password', password);
    if (csrf) body.append('_token', csrf);

    const postRes = await client.post(effectiveUrl, body.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': parseCookies(pageCookies),
        'Referer': effectiveUrl,
        'Origin': 'https://sitampan.pertanian.go.id',
      },
      maxRedirects: 10,
      validateStatus: s => s < 600,
    });

    debug.push(`POST status: ${postRes.status}`);
    const postCookies = postRes.headers['set-cookie'] || [];
    const allCookies  = mergeAndDedupeCookies(pageCookies, postCookies);
    debug.push(`Combined cookies: ${allCookies.substring(0, 60)}...`);

    // STEP 3: Verify
    debug.push('Step 3: Verify access to rekap page...');
    const verifyRes = await client.get(`${BASE_URL}/admin/form-sp/rekap`, {
      headers: { 'Cookie': allCookies, 'Referer': `${BASE_URL}/admin` },
      maxRedirects: 10,
      validateStatus: s => s < 600,
    });

    debug.push(`Verify status: ${verifyRes.status}`);
    const html      = verifyRes.data || '';
    const verifyUrl = verifyRes.request?.res?.responseUrl || '';

    const isLoggedIn =
      html.includes('Rekap SP') ||
      html.includes('selectedType') ||
      html.includes('id_cms_pangans') ||
      html.includes('Luas Tanam') ||
      html.includes('Dit Akabi') ||
      (verifyRes.status === 200 && !verifyUrl.includes('/login'));

    debug.push(`Is logged in: ${isLoggedIn}, verifyUrl: ${verifyUrl}`);

    if (!isLoggedIn) {
      const wrongCreds = html.includes('credentials') || html.includes('salah') || verifyUrl.includes('/login');
      return res.status(401).json({
        success: false,
        message: wrongCreds ? 'Username atau password salah.' : 'Login gagal. Tidak bisa akses halaman rekap.',
        debug
      });
    }

    // Persist session in KV
    const session = await getSession(req);
    session.cookies  = allCookies;
    session.username = username;
    await saveSession(req, res, session);

    return res.json({ success: true, message: 'Login berhasil!', debug });

  } catch (err) {
    console.error('[AUTH]', err.message, err.code);
    debug.push(`Exception: ${err.message} (${err.code})`);
    if (err.response) debug.push(`Response status: ${err.response.status}`);

    let msg = `Error: ${err.message}`;
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') msg = 'Timeout. Server SIPDPS lambat merespons.';
    if (err.code === 'ECONNREFUSED') msg = 'Tidak bisa terhubung ke server SIPDPS.';
    if (err.response?.status === 404) msg = 'URL login tidak ditemukan (404). Hubungi developer.';

    return res.status(500).json({ success: false, message: msg, debug });
  }
};
