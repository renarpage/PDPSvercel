/**
 * lib/scraper-helpers.js
 * Pure data + helpers shared by all scrape API routes.
 * No Express, no I/O — safe to require from any serverless function.
 */

const axios  = require('axios');
const https  = require('https');
const cheerio = require('cheerio');

const BASE_URL = 'https://sitampan.pertanian.go.id/sipdps';

const PROVINCES = [
  { id: '1',  bpsId: '11', name: 'ACEH' },
  { id: '2',  bpsId: '12', name: 'SUMATERA UTARA' },
  { id: '3',  bpsId: '13', name: 'SUMATERA BARAT' },
  { id: '4',  bpsId: '14', name: 'RIAU' },
  { id: '5',  bpsId: '15', name: 'JAMBI' },
  { id: '6',  bpsId: '16', name: 'SUMATERA SELATAN' },
  { id: '7',  bpsId: '17', name: 'BENGKULU' },
  { id: '8',  bpsId: '18', name: 'LAMPUNG' },
  { id: '9',  bpsId: '19', name: 'KEPULAUAN BANGKA BELITUNG' },
  { id: '10', bpsId: '21', name: 'KEPUALAUAN RIAU' },
  { id: '11', bpsId: '31', name: 'DKI JAKARTA' },
  { id: '12', bpsId: '32', name: 'JAWA BARAT' },
  { id: '13', bpsId: '33', name: 'JAWA TENGAH' },
  { id: '14', bpsId: '34', name: 'DAERAH ISTIMEWA YOGYAKARTA' },
  { id: '15', bpsId: '35', name: 'JAWA TIMUR' },
  { id: '16', bpsId: '36', name: 'BANTEN' },
  { id: '17', bpsId: '51', name: 'BALI' },
  { id: '18', bpsId: '52', name: 'NUSA TENGGARA BARAT' },
  { id: '19', bpsId: '53', name: 'NUSA TENGGARA TIMUR' },
  { id: '20', bpsId: '61', name: 'KALIMANTAN BARAT' },
  { id: '21', bpsId: '62', name: 'KALIMANTAN TENGAH' },
  { id: '22', bpsId: '63', name: 'KALIMANTAN SELATAN' },
  { id: '23', bpsId: '64', name: 'KALIMANTAN TIMUR' },
  { id: '24', bpsId: '65', name: 'KALIMANTAN UTARA' },
  { id: '25', bpsId: '71', name: 'SULAWESI UTARA' },
  { id: '26', bpsId: '72', name: 'SULAWESI TENGAH' },
  { id: '27', bpsId: '73', name: 'SULAWESI SELATAN' },
  { id: '28', bpsId: '74', name: 'SULAWESI TENGGARA' },
  { id: '29', bpsId: '75', name: 'GORONTALO' },
  { id: '30', bpsId: '76', name: 'SULAWESI BARAT' },
  { id: '31', bpsId: '81', name: 'MALUKU' },
  { id: '32', bpsId: '82', name: 'MALUKU UTARA' },
  { id: '33', bpsId: '91', name: 'PAPUA BARAT' },
  { id: '35', bpsId: '92', name: 'PAPUA BARAT DAYA' },
  { id: '34', bpsId: '94', name: 'PAPUA' },
  { id: '36', bpsId: '95', name: 'PAPUA SELATAN' },
  { id: '37', bpsId: '96', name: 'PAPUA TENGAH' },
  { id: '38', bpsId: '97', name: 'PAPUA PEGUNUNGAN' }
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const PROV_BPS_MAP = {};
PROVINCES.forEach(p => { PROV_BPS_MAP[p.name.toUpperCase()] = p.bpsId; });

const PROV_ID_MAP = {};
PROVINCES.forEach(p => { PROV_ID_MAP[p.name.toUpperCase()] = p.id; });

const sleep = ms => new Promise(r => setTimeout(r, ms));

function toTitleCase(str) {
  if (!str) return str;
  return str.toLowerCase().replace(/(?:^|\s)\S/g, c => c.toUpperCase());
}

function parseNum(str) {
  if (!str || str.trim() === '' || str.trim() === '-') return 0;
  const cleaned = str.trim().replace(/\./g, '').replace(',', '.');
  const val = parseFloat(cleaned);
  return isNaN(val) ? 0 : val;
}

function isValidAreaName(str) {
  if (!str || str.trim() === '' || str.trim() === '-') return false;
  const s = str.trim();
  if (/^[\d.,\s]+$/.test(s)) return false;
  if (/^\d/.test(s) && !/[A-Za-z]/.test(s)) return false;
  return true;
}

// ── HTTP client (SSL bypass for sitampan.pertanian.go.id) ────────────────────
const httpClient = axios.create({
  httpsAgent: new https.Agent({ rejectUnauthorized: false }),
  timeout: 25000,
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'id-ID,id;q=0.9,en-US;q=0.8',
  }
});

async function fetchPage(url, cookies) {
  const res = await httpClient.get(url, {
    headers: {
      'Cookie': cookies,
      'Referer': `${BASE_URL}/admin/form-sp/rekap`
    },
    maxRedirects: 5,
    validateStatus: s => s < 500
  });
  return res.data;
}

function parseTable(html) {
  const $ = cheerio.load(html);
  const rows = [];

  $('table tbody tr').each((i, row) => {
    const cells = $(row).find('td');
    if (cells.length < 14) return;

    const idCell  = $(cells[0]).text().trim();
    const sipdpsId = /^\d+$/.test(idCell) ? idCell : null;

    let hrefId = null;
    const link = $(cells[0]).find('a').attr('href') || $(cells[1]).find('a').attr('href') || '';
    const kabMatch = link.match(/id_cms_kabupatens=(\d+)/);
    const kecMatch = link.match(/id_cms_kecamatans=(\d+)/);
    if (kabMatch) hrefId = kabMatch[1];
    else if (kecMatch) hrefId = kecMatch[1];

    const name = $(cells[1]).text().trim();

    if (!isValidAreaName(name)) return;
    if (/^(total|jumlah|sub[\s-]?total|grand[\s-]?total)$/i.test(name)) return;

    const entry = {
      name,
      sipdpsId: hrefId || sipdpsId || String(i + 1)
    };
    MONTHS.forEach((m, idx) => { entry[m] = parseNum($(cells[idx + 2]).text()); });
    entry['Total'] = parseNum($(cells[14]).text());
    rows.push(entry);
  });

  // tfoot total row
  let totalEntry = null;
  const tfootRow   = $('table tfoot tr').first();
  const tfootCells = tfootRow.find('td, th');
  if (tfootCells.length >= 14) {
    totalEntry = { name: 'Total', isTotal: true };
    MONTHS.forEach((m, idx) => { totalEntry[m] = parseNum($(tfootCells[idx + 2]).text()); });
    totalEntry['Total'] = parseNum($(tfootCells[14]).text());
  }

  if (!totalEntry) {
    const lastRow   = $('table tbody tr').last();
    const lastCells = lastRow.find('td');
    const fc = $(lastCells[0]).text().trim().toLowerCase();
    const sc = $(lastCells[1]).text().trim().toLowerCase();
    if (fc.includes('total') || sc.includes('total') || fc === '' || fc === '-') {
      totalEntry = { name: 'Total', isTotal: true };
      MONTHS.forEach((m, idx) => { totalEntry[m] = parseNum($(lastCells[idx + 2]).text()); });
      totalEntry['Total'] = parseNum($(lastCells[14]).text());
      if (rows.length > 0) {
        const last = rows[rows.length - 1];
        if (last.name.toLowerCase().includes('total') || last.name === '' || last.name === '-') rows.pop();
      }
    }
  }

  return { rows, totalEntry };
}

async function fetchKabupatenIdsFromSelect(provId, cookies, commodity, year, type) {
  const url = `${BASE_URL}/admin/form-sp/rekap?selectedType=${type}&y=${year}` +
    `&id_cms_pangans=${encodeURIComponent(commodity)}&id_cms_provinsis=${provId}`;

  let html;
  try {
    html = await fetchPage(url, cookies);
  } catch(e) {
    console.warn(`[kabSelect] Gagal fetch provId=${provId}: ${e.message}`);
    return new Map();
  }

  const $   = cheerio.load(html);
  const map = new Map();

  $('select[name="id_cms_kabupatens"] option').each((_, el) => {
    const val  = $(el).attr('value');
    const nama = $(el).text().trim().toUpperCase();
    if (val && /^\d+$/.test(val.trim())) {
      map.set(nama, val.trim());
    }
  });

  return map;
}

function resolveKabId(kabName, provSelectMap, hrefId, fallbackId) {
  if (provSelectMap && provSelectMap.size > 0) {
    const upperName = kabName.toUpperCase();
    if (provSelectMap.has(upperName)) return provSelectMap.get(upperName);
    for (const [key, val] of provSelectMap.entries()) {
      if (key.includes(upperName) || upperName.includes(key)) return val;
    }
  }
  if (hrefId && /^\d+$/.test(hrefId)) return hrefId;
  return fallbackId;
}

module.exports = {
  BASE_URL, PROVINCES, MONTHS, PROV_BPS_MAP, PROV_ID_MAP,
  sleep, toTitleCase, parseNum, isValidAreaName,
  httpClient, fetchPage, parseTable, fetchKabupatenIdsFromSelect, resolveKabId
};
