/**
 * api/scrape/start.js  →  POST /api/scrape/start
 *
 * Creates a job entry in KV and immediately begins scraping.
 *
 * ⚠️  VERCEL FUNCTION DURATION
 * Vercel Pro allows up to 300 s per function (configured in vercel.json).
 * For the "semua" scope spanning many provinces, scraping can exceed this.
 * In that case, consider splitting into batches (see README) or using a
 * dedicated long-running server / Vercel Cron + Queue approach.
 *
 * The scrape runs inside this same invocation, writing progress to KV as it
 * goes so the /progress endpoint can be polled by the frontend.
 */

const crypto = require('crypto');
const { getSession } = require('../../lib/session');
const { getKv }      = require('../../lib/kv');
const {
  PROVINCES, MONTHS,
  sleep, fetchPage, parseTable, fetchKabupatenIdsFromSelect, resolveKabId
} = require('../../lib/scraper-helpers');
const { buildExcelWorkbook, buildExcelWorkbookMultiYear } = require('../../lib/excel-builder');

const BASE_URL = 'https://sitampan.pertanian.go.id/sipdps';
const JOB_TTL  = 60 * 60 * 6;  // keep job data for 6 hours

// ─────────────────────────────────────────────
// KV job helpers
// ─────────────────────────────────────────────

async function readJob(kv, jobId) {
  const raw = await kv.get(`job:${jobId}`).catch(() => null);
  if (!raw) return null;
  return typeof raw === 'string' ? JSON.parse(raw) : raw;
}

async function writeJob(kv, jobId, job) {
  await kv.set(`job:${jobId}`, JSON.stringify(job), { ex: JOB_TTL });
}

// ─────────────────────────────────────────────
// SCRAPE JOB RUNNER
// ─────────────────────────────────────────────

async function runScrapeJob(jobId, cookies, kv) {
  let job = await readJob(kv, jobId);
  const { years, yearFrom, yearTo, commodity, types, scope, provinceIds, kabupatenNames } = job.params;
  const opts        = job.excelOptions || {};
  const hasKabFilter = kabupatenNames && kabupatenNames.length > 0;

  // Per-job select cache (in-memory, scoped to this invocation)
  const kabSelectCache = {};

  const allDataByYear = {};

  const selectedProvinces = (scope === 'national' || scope === 'semua') ? [] :
    (provinceIds && provinceIds.length > 0 ? PROVINCES.filter(p => provinceIds.includes(p.id)) : PROVINCES);
  const provincesToScrape = scope === 'semua' ? PROVINCES : selectedProvinces;

  // Calculate total operations
  let totalOps = 0;
  for (const _yr of years) {
    for (const type of types) {
      if (scope === 'national' || scope === 'all' || scope === 'semua' || scope === 'provinsi') totalOps++;
      if (scope !== 'national') {
        totalOps += provincesToScrape.length;
        if (scope === 'all' || scope === 'kabupaten' || scope === 'semua') {
          totalOps += provincesToScrape.length;
        }
      }
    }
  }

  job.total = totalOps;
  await writeJob(kv, jobId, job);
  let doneOps = 0;

  // Helper: persist log+progress without holding entire data in memory every write
  async function tick(logMsg) {
    job = await readJob(kv, jobId);
    if (logMsg) job.log.push(logMsg);
    doneOps++;
    job.progress = Math.round((doneOps / totalOps) * 100);
    // Don't write data yet — keep writes small during scrape
    const { data, ...slim } = job;
    await writeJob(kv, jobId, { ...slim, data: null });
  }

  for (const year of years) {
    const yearLabel = years.length > 1 ? ` [${year}]` : '';
    allDataByYear[year] = {};

    for (const type of types) {
      const typeLabel = { tanam: 'Luas Tanam', panen: 'Luas Panen', puso: 'Luas Puso' }[type] || type;
      allDataByYear[year][type] = {};

      // ── National / Provinsi level ──
      if (scope === 'national' || scope === 'all' || scope === 'provinsi' || scope === 'semua') {
        job.log.push(`📊 Nasional${yearLabel} — ${typeLabel}...`);
        const url = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${year}&id_cms_pangans=${encodeURIComponent(commodity)}`;
        try {
          const html = await fetchPage(url, cookies);
          const { rows, totalEntry } = parseTable(html);
          allDataByYear[year][type]['NASIONAL']       = rows;
          allDataByYear[year][type]['NASIONAL_TOTAL'] = totalEntry;
          job.log.push(`✅ Nasional${yearLabel}: ${rows.length} provinsi`);
        } catch(e) {
          job.log.push(`❌ Nasional${yearLabel}: ${e.message}`);
          allDataByYear[year][type]['NASIONAL'] = [];
        }
        await tick();
        await sleep(400);
      }

      // ── Province & Kabupaten level ──
      if (scope !== 'national') {
        for (const prov of provincesToScrape) {
          job.log.push(`🗺️ ${prov.name}${yearLabel} — ${typeLabel}...`);
          const provUrl = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${year}&id_cms_pangans=${encodeURIComponent(commodity)}&id_cms_provinsis=${prov.id}`;
          try {
            const html = await fetchPage(provUrl, cookies);
            const { rows, totalEntry } = parseTable(html);
            const filteredRows = hasKabFilter
              ? rows.filter(r => kabupatenNames.some(
                  k => r.name.toLowerCase().includes(k.toLowerCase()) || k.toLowerCase().includes(r.name.toLowerCase())
                ))
              : rows;
            allDataByYear[year][type][prov.name]             = filteredRows;
            allDataByYear[year][type][`${prov.name}_TOTAL`] = totalEntry;
            job.log.push(`✅ ${prov.name}${yearLabel}: ${filteredRows.length} kab/kota`);
          } catch(e) {
            job.log.push(`❌ ${prov.name}${yearLabel}: ${e.message}`);
            allDataByYear[year][type][prov.name] = [];
          }
          await tick();
          await sleep(300);

          // ── Kabupaten → Kecamatan ──
          if (scope === 'all' || scope === 'semua') {
            const kabList = allDataByYear[year][type][prov.name] || [];
            let kecFetched = 0;

            let provSelectMap = kabSelectCache[prov.id];
            if (!provSelectMap) {
              provSelectMap = await fetchKabupatenIdsFromSelect(prov.id, cookies, commodity, year, type);
              kabSelectCache[prov.id] = provSelectMap;
            }

            if (provSelectMap.size > 0) {
              job.log.push(`  🔍 ${prov.name}: ${provSelectMap.size} kabupaten ID dari select HTML`);
            } else {
              job.log.push(`  ⚠️ ${prov.name}: select HTML kosong, fallback ke ID dari tabel`);
            }
            await sleep(300);

            for (const kab of kabList) {
              if (!kab.name || kab.name.toLowerCase() === 'total') continue;
              const kabKey        = `${prov.name} > ${kab.name}`;
              const resolvedKabId = resolveKabId(kab.name, provSelectMap, kab.sipdpsId, null);

              let kabUrl;
              if (resolvedKabId) {
                kabUrl = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${year}` +
                  `&id_cms_pangans=${encodeURIComponent(commodity)}` +
                  `&id_cms_provinsis=${prov.id}&id_cms_kabupatens=${resolvedKabId}`;
              } else {
                kabUrl = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${year}` +
                  `&id_cms_pangans=${encodeURIComponent(commodity)}` +
                  `&id_cms_provinsis=${prov.id}&id_kabupaten=${encodeURIComponent(kab.name)}`;
                job.log.push(`  ⚠️ ${kab.name}: ID tidak ditemukan, fallback ke nama`);
              }

              kab.sipdpsId = resolvedKabId || kab.sipdpsId;

              try {
                const html = await fetchPage(kabUrl, cookies);
                const { rows } = parseTable(html);
                allDataByYear[year][type][kabKey] = rows;
                if (rows.length > 0) kecFetched += rows.length;
              } catch(e) {
                allDataByYear[year][type][kabKey] = [];
              }
              await sleep(200);
            }

            if (kecFetched > 0) {
              job.log.push(`  📍 ${prov.name}${yearLabel}: ${kecFetched} kecamatan dari ${kabList.length} kab/kota`);
            }
            await tick();
          }
        }
      }
    }
  }

  // ── Build Excel ──
  job = await readJob(kv, jobId);
  job.log.push('📦 Menyusun file Excel...');
  await writeJob(kv, jobId, job);

  const isSingleYear = years.length === 1;
  const allData      = isSingleYear ? allDataByYear[years[0]] : null;

  const wb = isSingleYear
    ? await buildExcelWorkbook(allData, { year: String(years[0]), commodity, types, scope }, opts)
    : await buildExcelWorkbookMultiYear(allDataByYear, { yearFrom, yearTo, years, commodity, types, scope }, opts);

  const buffer = await wb.xlsx.writeBuffer();

  const today    = new Date();
  const dateStr  = today.getFullYear().toString()
    + String(today.getMonth() + 1).padStart(2, '0')
    + String(today.getDate()).padStart(2, '0');
  const yearRange = yearFrom === yearTo ? String(yearFrom) : `${yearFrom}-${yearTo}`;

  let filename;
  if (opts.customFilename) {
    filename = opts.customFilename.endsWith('.xlsx') ? opts.customFilename : opts.customFilename + '.xlsx';
  } else {
    const tCode = types.map(t => t.toUpperCase()).join('_');
    filename = `SIPDPS_${tCode}_${commodity.replace(/ /g, '_').toUpperCase()}_${yearRange}_${dateStr}.xlsx`;
  }

  // Write final job state — base64 data goes into KV
  job = await readJob(kv, jobId);
  job.data     = buffer.toString('base64');
  job.status   = 'done';
  job.progress = 100;
  job.filename = filename;
  job.log.push(`🎉 Selesai! File siap diunduh: ${filename}`);
  await writeJob(kv, jobId, job);
}

// ─────────────────────────────────────────────
// HANDLER
// ─────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const session = await getSession(req);
  if (!session.cookies) {
    return res.status(401).json({ error: 'Tidak terautentikasi. Silakan login terlebih dahulu.' });
  }

  const { yearFrom, yearTo, year, commodity, types, scope, provinceIds, kabupatenNames, excelOptions = {} } = req.body;
  const from = parseInt(yearFrom || year);
  const to   = yearTo ? parseInt(yearTo) : from;

  if (!from || isNaN(from) || !commodity || !types || types.length === 0) {
    return res.status(400).json({ error: 'Parameter tidak lengkap' });
  }
  if (to < from) {
    return res.status(400).json({ error: 'Tahun akhir tidak boleh lebih kecil dari tahun awal' });
  }

  const yearsToScrape = [];
  for (let y = from; y <= to; y++) yearsToScrape.push(y);

  const jobId = crypto.randomBytes(8).toString('hex');
  const kv    = getKv();

  const job = {
    status: 'running', progress: 0, total: 0,
    log: [], data: null, error: null, filename: null,
    params: {
      yearFrom: from, yearTo: to, years: yearsToScrape,
      commodity, types, scope,
      provinceIds: provinceIds || [],
      kabupatenNames: kabupatenNames || []
    },
    excelOptions
  };

  await writeJob(kv, jobId, job);

  // Respond immediately with jobId, then run the scrape in the same invocation.
  // The response is sent, and Vercel keeps the function alive until it returns.
  res.json({ jobId });

  try {
    await runScrapeJob(jobId, session.cookies, kv);
  } catch (err) {
    console.error('[SCRAPE]', err.message);
    const failedJob = await readJob(kv, jobId) || {};
    failedJob.status = 'error';
    failedJob.error  = err.message;
    if (!failedJob.log) failedJob.log = [];
    failedJob.log.push(`❌ Fatal error: ${err.message}`);
    await writeJob(kv, jobId, failedJob);
  }
};
