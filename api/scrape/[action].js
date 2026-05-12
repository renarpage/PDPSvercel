/**
 * api/scrape/[action].js
 *
 * Handles all remaining /api/scrape/* routes:
 *   GET  /api/scrape/provinces
 *   GET  /api/scrape/progress/:jobId          → query: ?jobId=xxx
 *   GET  /api/scrape/download/:jobId          → query: ?jobId=xxx
 *   GET  /api/scrape/preview                  → query: commodity, year, type
 *   GET  /api/scrape/kabupaten/:provId        → query: ?provId=xxx
 *   GET  /api/scrape/kabupaten-select/:provId → query: ?provId=xxx&commodity&year&type
 *   GET  /api/scrape/debug
 *
 * Vercel dynamic routes map [action] to the path segment, but sub-segments
 * (e.g. /progress/abc123) arrive as: action='progress', jobId='abc123'.
 * We use req.query for everything.
 */

const { getSession }    = require('../../lib/session');
const { getKv }         = require('../../lib/kv');
const {
  PROVINCES, BASE_URL,
  fetchPage, parseTable, fetchKabupatenIdsFromSelect,
  MONTHS, PROV_BPS_MAP
} = require('../../lib/scraper-helpers');

async function readJob(kv, jobId) {
  const raw = await kv.get(`job:${jobId}`).catch(() => null);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

module.exports = async function handler(req, res) {
  // Extract action and any sub-path segments from the URL
  const url      = req.url || '';
  const segments = url.replace(/^\/api\/scrape\/?/, '').split('?')[0].split('/').filter(Boolean);
  const action   = segments[0];
  const subParam = segments[1]; // e.g. jobId or provId

  const kv      = getKv();
  const session = await getSession(req);

  // ── GET /api/scrape/provinces ─────────────────────────────────────────────
  if (action === 'provinces' && req.method === 'GET') {
    return res.json(PROVINCES);
  }

  // ── GET /api/scrape/progress/:jobId ──────────────────────────────────────
  if (action === 'progress' && req.method === 'GET') {
    const jobId = subParam || req.query.jobId;
    if (!jobId) return res.status(400).json({ error: 'jobId diperlukan' });

    const job = await readJob(kv, jobId);
    if (!job) return res.status(404).json({ error: 'Job tidak ditemukan' });

    return res.json({
      status  : job.status,
      progress: job.progress,
      total   : job.total,
      log     : job.log,
      error   : job.error,
      filename: job.filename || null,
      hasData : !!job.data
    });
  }

  // ── GET /api/scrape/download/:jobId ──────────────────────────────────────
  if (action === 'download' && req.method === 'GET') {
    const jobId = subParam || req.query.jobId;
    if (!jobId) return res.status(400).json({ error: 'jobId diperlukan' });

    const job = await readJob(kv, jobId);
    if (!job || !job.data) return res.status(404).json({ error: 'File tidak tersedia' });

    const buffer = Buffer.from(job.data, 'base64');
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${job.filename}"`);
    return res.send(buffer);
  }

  // ── Auth-gated routes below ───────────────────────────────────────────────
  if (!session.cookies) {
    return res.status(401).json({ error: 'Tidak terautentikasi.' });
  }

  // ── GET /api/scrape/preview ───────────────────────────────────────────────
  if (action === 'preview' && req.method === 'GET') {
    const { commodity, year, type = 'panen' } = req.query;
    if (!commodity || !year) return res.status(400).json({ error: 'Parameter tidak lengkap.' });
    try {
      const url  = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${year}&id_cms_pangans=${encodeURIComponent(commodity)}`;
      const html = await fetchPage(url, session.cookies);
      const { rows, totalEntry } = parseTable(html);
      const monthlyNational = MONTHS.map(m => rows.reduce((s, r) => s + (r[m] || 0), 0));
      return res.json({ rows, totalEntry, monthlyNational });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET /api/scrape/kabupaten/:provId ─────────────────────────────────────
  if (action === 'kabupaten' && req.method === 'GET') {
    const provId = subParam || req.query.provId;
    if (!provId) return res.status(400).json({ error: 'provId diperlukan' });

    const prov = PROVINCES.find(p => p.id === provId);
    if (!prov) return res.status(404).json({ error: 'Provinsi tidak ditemukan.' });

    try {
      const selectMap = await fetchKabupatenIdsFromSelect(provId, session.cookies, 'Padi', '2024', 'panen');

      if (selectMap.size > 0) {
        const kabList = [...selectMap.entries()].map(([nama, sipdpsId]) => ({ name: nama, sipdpsId }));
        return res.json(kabList);
      }

      const url  = `${BASE_URL}/admin/form-sp/rekap?selectedType=panen&y=2024&id_cms_pangans=Padi&id_cms_provinsis=${provId}`;
      const html = await fetchPage(url, session.cookies);
      const { rows } = parseTable(html);
      const kabList  = rows
        .filter(r => r.name && r.name.toLowerCase() !== 'total')
        .map((r, i) => ({ name: r.name, sipdpsId: r.sipdpsId || String(i + 1) }));
      return res.json(kabList);
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET /api/scrape/kabupaten-select/:provId ──────────────────────────────
  if (action === 'kabupaten-select' && req.method === 'GET') {
    const provId = subParam || req.query.provId;
    if (!provId) return res.status(400).json({ error: 'provId diperlukan' });

    const prov = PROVINCES.find(p => p.id === provId);
    if (!prov) return res.status(404).json({ error: 'Provinsi tidak ditemukan.' });

    const { commodity = 'Padi', year = '2026', type = 'tanam' } = req.query;
    try {
      const selectMap = await fetchKabupatenIdsFromSelect(provId, session.cookies, commodity, year, type);
      const list = [...selectMap.entries()].map(([nama, sipdpsId]) => ({ nama, sipdpsId }));
      return res.json({
        provId, provName: prov.name,
        count: list.length,
        source: 'select_html',
        list
      });
    } catch(e) {
      return res.status(500).json({ error: e.message });
    }
  }

  // ── GET /api/scrape/debug ─────────────────────────────────────────────────
  if (action === 'debug' && req.method === 'GET') {
    const { type = 'tanam', y = '2026', commodity = 'Padi', provId, kabId } = req.query;
    const debugLog = [];
    const results  = {};

    try {
      const nasUrl  = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${y}&id_cms_pangans=${encodeURIComponent(commodity)}`;
      debugLog.push({ level: 'nasional', url: nasUrl });
      const nasHtml = await fetchPage(nasUrl, session.cookies);
      const { rows: nasRows, totalEntry: nasTotal } = parseTable(nasHtml);
      results.nasional = { rowCount: nasRows.length, totalEntry: nasTotal, rows: nasRows.slice(0, 5), url: nasUrl };
      debugLog.push({ level: 'nasional', rowCount: nasRows.length, status: 'OK' });

      if (provId) {
        const prov    = PROVINCES.find(p => p.id === provId);
        const provUrl = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${y}&id_cms_pangans=${encodeURIComponent(commodity)}&id_cms_provinsis=${provId}`;
        debugLog.push({ level: 'provinsi', provId, provName: prov?.name, url: provUrl });
        const provHtml = await fetchPage(provUrl, session.cookies);
        const { rows: provRows, totalEntry: provTotal } = parseTable(provHtml);
        results.provinsi = {
          provId, provName: prov?.name,
          rowCount: provRows.length, totalEntry: provTotal, rows: provRows.slice(0, 5), url: provUrl,
          cascadeCheck: {
            expectedInNasional: nasRows.some(r => r.name.toUpperCase() === prov?.name?.toUpperCase()),
            nasionalEntry: nasRows.find(r => r.name.toUpperCase() === prov?.name?.toUpperCase()) || null
          }
        };
        debugLog.push({ level: 'provinsi', rowCount: provRows.length, status: 'OK' });

        if (kabId) {
          const kabName = provRows.find(r => r.sipdpsId === kabId)?.name || `ID ${kabId}`;
          const kabUrl  = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${y}&id_cms_pangans=${encodeURIComponent(commodity)}&id_cms_provinsis=${provId}&id_cms_kabupatens=${kabId}`;
          debugLog.push({ level: 'kabupaten', kabId, kabName, url: kabUrl });
          const kabHtml = await fetchPage(kabUrl, session.cookies);
          const { rows: kecRows, totalEntry: kecTotal } = parseTable(kabHtml);
          results.kabupaten = {
            kabId, kabName,
            rowCount: kecRows.length, totalEntry: kecTotal, rows: kecRows.slice(0, 10), url: kabUrl,
            cascadeCheck: {
              expectedInProvinsi: provRows.some(r => r.sipdpsId === kabId || r.name === kabName),
              provinsiEntry: provRows.find(r => r.sipdpsId === kabId || r.name === kabName) || null
            }
          };
          debugLog.push({ level: 'kabupaten', rowCount: kecRows.length, status: 'OK' });
        }
      }

      const integrityIssues = [];
      if (results.provinsi && !results.provinsi.cascadeCheck.expectedInNasional) {
        integrityIssues.push(`⚠️ Province "${results.provinsi.provName}" tidak ditemukan di data Nasional`);
      }
      if (results.kabupaten && !results.kabupaten.cascadeCheck.expectedInProvinsi) {
        integrityIssues.push(`⚠️ Kabupaten ID "${kabId}" tidak ditemukan di data Provinsi`);
      }

      return res.json({
        success: true,
        params: { type, y, commodity, provId, kabId },
        results, debugLog, integrityIssues,
        integrityOK: integrityIssues.length === 0
      });
    } catch(err) {
      return res.status(500).json({ success: false, error: err.message, debugLog });
    }
  }

  return res.status(404).json({ error: 'Route tidak ditemukan' });
};
