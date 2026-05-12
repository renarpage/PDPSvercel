/**
 * api/auth/login.js  →  POST /api/auth/login
 *
 * Authenticates against SIPDPS and stores the session cookies in Redis.
 * Body: { username, password, webPassword }
 */

const axios  = require('axios');
const https  = require('https');
const { getSession, saveSession } = require('../../lib/session');

const BASE_URL = 'https://sitampan.pertanian.go.id/sipdps';

// Daftar URL login yang akan dicoba secara berurutan
const LOGIN_URLS = [
  `${BASE_URL}/admin/login`,
  `${BASE_URL}/auth/login`,
  `${BASE_URL}/login`,
  'https://sitampan.pertanian.go.id/login',
  'https://sitampan.pertanian.go.id/admin/login',
];

// Header semirip mungkin dengan browser Chrome Indonesia
const BROWSER_HEADERS = {
  'User-Agent'     : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept'         : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8,en;q=0.7',
  'Accept-Encoding': 'gzip, deflate, br',
  'Cache-Control'  : 'no-cache',
  'Pragma'         : 'no-cache',
  'Sec-Ch-Ua'      : '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
  'Sec-Ch-Ua-Mobile'  : '?0',
  'Sec-Ch-Ua-Platform': '"Windows"',
  'Sec-Fetch-Dest' : 'document',
  'Sec-Fetch-Mode' : 'navigate',
  'Sec-Fetch-Site' : 'none',
  'Sec-Fetch-User' : '?1',
  'Upgrade-Insecure-Requests': '1',
  'Connection'     : 'keep-alive',
};

const httpsAgent = new https.Agent({
  rejectUnauthorized: false,
  keepAlive: true,
});

const client = axios.create({
  httpsAgent,
  timeout: 45000,
  headers: BROWSER_HEADERS,
  maxRedirects: 15,
  validateStatus: s => s < 600,
});

function parseCookies(setCookieArr) {
  if (!setCookieArr || !setCookieArr.length) return '';
  return setCookieArr.map(c => c.split(';')[0]).join('; ');
}

function extractCsrf(html) {
  const patterns = [
    /name="_token"\s+value="([^"]+)"/,
    /name="_token" value="([^"]+)"/,
    /name="csrf_token"\s+value="([^"]+)"/,
    /<meta\s+name="csrf-token"\s+content="([^"]+)"/i,
    /["']_token["']\s*:\s*["']([^"']+)["']/,
    /csrfToken\s*=\s*["']([^"']+)["']/,
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
      if (name) map.set(name.trim(), pair);
    }
  }
  return [...map.values()].join('; ');
}

// Coba GET ke beberapa URL sampai berhasil (status < 400)
async function tryGetLoginPage(debug) {
  for (const url of LOGIN_URLS) {
    try {
      debug.push(`Trying GET ${url}`);
      const r = await client.get(url);
      if (r.status < 400) {
        debug.push(`  → OK (${r.status})`);
        return { res: r, url };
      }
      debug.push(`  → ${r.status}, skip`);
    } catch (e) {
      debug.push(`  → Error: ${e.message}`);
    }
  }
  return null;
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
    return res.status(500).json({ success: false, message: 'Konfigurasi server: WEB_PASSWORD belum diatur' });
  }
  if (!webPassword || webPassword !== WEB_PASSWORD) {
    return res.status(403).json({ success: false, message: 'Web password salah. Akses ditolak.' });
  }

  const debug = [];

  try {
    // ── STEP 1: GET login page ─────────────────────────────────────────────
    debug.push('Step 1: Mencari halaman login...');
    const found = await tryGetLoginPage(debug);

    if (!found) {
      return res.status(502).json({
        success: false,
        message: 'Tidak bisa mengakses halaman login SIPDPS. Server mungkin memblokir IP Vercel atau sedang down.',
        debug,
      });
    }

    const { res: pageRes, url: effectiveLoginUrl } = found;
    const pageCookies = pageRes.headers['set-cookie'] || [];
    const csrf        = extractCsrf(pageRes.data);
    const finalUrl    = pageRes.request?.res?.responseUrl || effectiveLoginUrl;

    debug.push(`Halaman login: ${finalUrl} (status ${pageRes.status})`);
    debug.push(`CSRF token: ${csrf ? csrf.substring(0, 16) + '...' : 'TIDAK DITEMUKAN'}`);
    debug.push(`Cookies dari halaman: ${pageCookies.length}`);

    // ── STEP 2: POST credentials ──────────────────────────────────────────
    debug.push('Step 2: POST kredensial...');

    const formBody = new URLSearchParams();
    formBody.append('username', username);
    formBody.append('email',    username);
    formBody.append('password', password);
    if (csrf) formBody.append('_token', csrf);

    const postRes = await client.post(finalUrl, formBody.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie'      : parseCookies(pageCookies),
        'Referer'     : finalUrl,
        'Origin'      : new URL(finalUrl).origin,
        'Sec-Fetch-Site': 'same-origin',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Dest': 'document',
      },
    });

    debug.push(`POST status: ${postRes.status}`);
    const postCookies = postRes.headers['set-cookie'] || [];
    const allCookies  = mergeAndDedupeCookies(pageCookies, postCookies);
    debug.push(`Total cookies: ${allCookies.substring(0, 80)}...`);

    if (!allCookies) {
      return res.status(401).json({
        success: false,
        message: 'Login gagal — tidak ada cookies dari server.',
        debug,
      });
    }

    // ── STEP 3: Verify session ─────────────────────────────────────────────
    debug.push('Step 3: Verifikasi sesi...');

    const VERIFY_PATHS = [
      `${BASE_URL}/admin/form-sp/rekap`,
      `${BASE_URL}/admin`,
      `${BASE_URL}/admin/dashboard`,
    ];

    let isLoggedIn = false;
    let verifyInfo = '';

    for (const vUrl of VERIFY_PATHS) {
      try {
        const vRes = await client.get(vUrl, {
          headers: {
            'Cookie' : allCookies,
            'Referer': finalUrl,
            'Sec-Fetch-Site': 'same-origin',
          },
        });
        const vHtml = vRes.data || '';
        const vFinal = vRes.request?.res?.responseUrl || vUrl;
        verifyInfo = `${vUrl} → ${vRes.status} (${vFinal})`;
        debug.push(`Verify: ${verifyInfo}`);

        const loginSuccess =
          vHtml.includes('Rekap SP')        ||
          vHtml.includes('selectedType')    ||
          vHtml.includes('id_cms_pangans')  ||
          vHtml.includes('Luas Tanam')      ||
          vHtml.includes('Dit Akabi')       ||
          vHtml.includes('logout')          ||
          vHtml.includes('Keluar')          ||
          (vRes.status === 200 && !vFinal.includes('/login'));

        if (loginSuccess) { isLoggedIn = true; break; }
      } catch (e) {
        debug.push(`Verify error on ${vUrl}: ${e.message}`);
      }
    }

    debug.push(`Login berhasil: ${isLoggedIn}`);

    if (!isLoggedIn) {
      return res.status(401).json({
        success: false,
        message: 'Login gagal. Username/password salah atau SIPDPS menolak akses.',
        debug,
      });
    }

    // ── Simpan session ke Redis ────────────────────────────────────────────
    const session    = await getSession(req);
    session.cookies  = allCookies;
    session.username = username;
    await saveSession(req, res, session);

    return res.json({ success: true, message: 'Login berhasil!', debug });

  } catch (err) {
    console.error('[AUTH/login]', err.message, err.code);
    debug.push(`Exception: ${err.message} (${err.code || '-'})`);
    if (err.response) debug.push(`Response status: ${err.response.status}`);

    let msg = `Error: ${err.message}`;
    if (err.code === 'ETIMEDOUT' || err.code === 'ECONNABORTED') {
      msg = 'Timeout. Server SIPDPS lambat merespons, coba lagi.';
    } else if (err.code === 'ECONNREFUSED') {
      msg = 'Tidak bisa terhubung ke server SIPDPS.';
    } else if (err.response?.status === 403) {
      msg = 'Server SIPDPS memblokir request (403). IP Vercel mungkin diblokir.';
    } else if (err.response?.status === 404) {
      msg = 'URL login tidak ditemukan (404). Hubungi developer.';
    }

    return res.status(500).json({ success: false, message: msg, debug });
  }
};
