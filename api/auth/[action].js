/**
 * api/auth/[action].js  →  POST /api/auth/logout | GET /api/auth/status | GET /api/auth/debug
 *
 * Vercel file-system routing: this file handles everything under /api/auth/
 * except /api/auth/login (handled by login.js).
 *
 * Routes:
 *   POST /api/auth/logout
 *   GET  /api/auth/status
 *   GET  /api/auth/debug
 */

const axios  = require('axios');
const https  = require('https');
const { getSession, clearSession } = require('../../lib/session');

const BASE_URL = 'https://sitampan.pertanian.go.id/sipdps';

const client = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 30000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  }
});

function extractCsrf(html) {
  const patterns = [
    /name="_token"\s+value="([^"]+)"/,
    /name="csrf_token"\s+value="([^"]+)"/,
    /<meta\s+name="csrf-token"\s+content="([^"]+)"/i,
  ];
  for (const p of patterns) {
    const m = html.match(p);
    if (m) return m[1];
  }
  return '';
}

module.exports = async function handler(req, res) {
  const { action } = req.query;

  // POST /api/auth/logout
  if (action === 'logout' && req.method === 'POST') {
    await clearSession(req, res);
    return res.json({ success: true });
  }

  // GET /api/auth/status
  if (action === 'status' && req.method === 'GET') {
    const session = await getSession(req);
    return res.json({ loggedIn: !!session.cookies, username: session.username || null });
  }

  // GET /api/auth/debug
  if (action === 'debug' && req.method === 'GET') {
    try {
      const r = await client.get(`${BASE_URL}/login`, { maxRedirects: 10, validateStatus: () => true });
      return res.json({
        status      : r.status,
        finalUrl    : r.request?.res?.responseUrl,
        csrfFound   : extractCsrf(r.data) !== '',
        cookieCount : (r.headers['set-cookie'] || []).length,
        htmlPreview : (r.data || '').substring(0, 800)
      });
    } catch(e) {
      return res.json({ error: e.message, code: e.code });
    }
  }

  return res.status(404).json({ error: 'Route tidak ditemukan' });
};
