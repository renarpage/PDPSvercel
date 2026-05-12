/**
 * lib/excel-builder.js
 * Builds .xlsx workbooks from scraped SIPDPS data.
 * Pure function — no Express, no I/O (except ExcelJS in-memory buffer).
 */

const ExcelJS = require('exceljs');
const {
  PROVINCES, MONTHS, PROV_BPS_MAP,
  toTitleCase, isValidAreaName
} = require('./scraper-helpers');

// ─────────────────────────────────────────────
// STYLE CONSTANTS
// ─────────────────────────────────────────────
const C_HEADER_BG   = 'FF1E5C2F';
const C_HEADER_FONT = 'FFFFFFFF';
const C_TOTAL_BG    = 'FFFFF3CC';
const C_ALT_ODD     = 'FFFAF6EE';
const C_ALT_EVEN    = 'FFFFFFFF';
const C_BORDER      = 'FFD0D0D0';
const C_SUBTOTAL_BG = 'FFE8F4E8';
const C_SUBTOTAL_FT = 'FF1E5C2F';
const C_BORDER_SUB  = 'FF9BBE9B';

const TAB_RINGKASAN = 'FF1E5C2F';
const TAB_PROVINSI  = 'FFD4A017';
const TAB_KABUPATEN = 'FFB8890E';
const TAB_KECAMATAN = 'FF9B7512';

function borderAll(style, argb) {
  return {
    top:    { style, color: { argb } },
    left:   { style, color: { argb } },
    bottom: { style, color: { argb } },
    right:  { style, color: { argb } }
  };
}

function applyHeaderStyle(ws, rowNum) {
  const row = ws.getRow(rowNum);
  row.height = 18;
  row.eachCell({ includeEmpty: true }, cell => {
    if (cell.value === null || cell.value === undefined) return;
    cell.fill      = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_HEADER_BG } };
    cell.font      = { bold: true, color: { argb: C_HEADER_FONT }, size: 10, name: 'Calibri' };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border    = borderAll('thin', C_BORDER);
  });
}

function applyDataRowStyle(ws, rowNum, isTotal, idColCount) {
  const row = ws.getRow(rowNum);
  row.height = 16;
  row.eachCell({ includeEmpty: true }, (cell, colNum) => {
    const bg = isTotal
      ? C_TOTAL_BG
      : (rowNum % 2 === 1 ? C_ALT_ODD : C_ALT_EVEN);

    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: bg } };
    cell.font   = { bold: isTotal, size: 10, name: 'Calibri' };
    cell.border = borderAll('thin', C_BORDER);
    cell.numFmt = 'General';

    if (colNum === 1 || (colNum > 1 && colNum <= idColCount + 1)) {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    } else if (colNum === idColCount + 2) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
    }
  });
}

function applySubtotalRowStyle(ws, rowNum, labelColNum, idColCount) {
  const row = ws.getRow(rowNum);
  row.height = 16;
  row.eachCell({ includeEmpty: true }, (cell, colNum) => {
    cell.fill   = { type: 'pattern', pattern: 'solid', fgColor: { argb: C_SUBTOTAL_BG } };
    cell.font   = { bold: true, italic: false, color: { argb: C_SUBTOTAL_FT }, size: 10, name: 'Calibri' };
    cell.border = {
      top:    { style: 'medium', color: { argb: C_BORDER_SUB } },
      left:   { style: 'thin',   color: { argb: C_BORDER } },
      bottom: { style: 'thin',   color: { argb: C_BORDER } },
      right:  { style: 'thin',   color: { argb: C_BORDER } },
    };
    cell.numFmt = 'General';
    if (colNum <= idColCount + 1) {
      cell.alignment = { vertical: 'middle', horizontal: 'center' };
    } else if (colNum === labelColNum) {
      cell.alignment = { vertical: 'middle', horizontal: 'left' };
    } else {
      cell.alignment = { vertical: 'middle', horizontal: 'right' };
    }
  });
}

function addTitleBlock(ws, title, subtitle, mergeEndCol) {
  ws.mergeCells(`A1:${mergeEndCol}1`);
  const t = ws.getCell('A1');
  t.value     = title;
  t.font      = { bold: true, size: 12, name: 'Calibri' };
  t.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height = 20;

  ws.mergeCells(`A2:${mergeEndCol}2`);
  const s = ws.getCell('A2');
  s.value     = subtitle;
  s.font      = { size: 9, italic: true, name: 'Calibri' };
  s.alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(2).height = 14;

  ws.addRow([]);
  ws.getRow(3).height = 6;
}

function setRingkasanAlign(ws, rowNum) {
  const row = ws.getRow(rowNum);
  row.getCell(1).alignment = { vertical: 'middle', horizontal: 'left' };
  row.getCell(2).alignment = { vertical: 'middle', horizontal: 'left' };
  row.getCell(3).alignment = { vertical: 'middle', horizontal: 'right' };
  row.getCell(4).alignment = { vertical: 'middle', horizontal: 'right' };
  row.getCell(5).alignment = { vertical: 'middle', horizontal: 'left' };
  row.height = 15;
}

// ─────────────────────────────────────────────
// SHEET BUILDERS
// ─────────────────────────────────────────────

function buildRingkasanSheet(wb, commodity, year, allData, types, opts) {
  const now        = new Date().toLocaleString('id-ID');
  const typeLabels = { tanam: 'Luas Tanam', panen: 'Luas Panen', puso: 'Luas Puso' };
  const ws         = wb.addWorksheet('RINGKASAN', { properties: { tabColor: { argb: TAB_RINGKASAN } } });

  ws.mergeCells('A1:Q1');
  ws.getCell('A1').value     = `REKAP DATA SIPDPS — ${commodity.toUpperCase()}`;
  ws.getCell('A1').font      = { bold: true, size: 14, name: 'Calibri' };
  ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
  ws.getRow(1).height        = 28;

  ws.mergeCells('A2:Q2');
  ws.getCell('A2').value     = `Tahun: ${year}  |  Dibuat: ${now}`;
  ws.getCell('A2').font      = { size: 10, italic: true, name: 'Calibri' };
  ws.getCell('A2').alignment = { horizontal: 'center' };
  ws.getRow(2).height        = 18;

  ws.addRow([]);

  ws.addRow(['Jenis Data', 'Wilayah', 'Jumlah Baris', 'Total (ha)', 'Status']);
  applyHeaderStyle(ws, 4);
  ws.getRow(4).height = 18;
  if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: 4 }];

  let rowNum = 5;

  for (const type of types) {
    const label    = typeLabels[type] || type;
    const typeData = allData[type] || {};

    const nasRows  = typeData['NASIONAL'] || [];
    const nasTotal = nasRows.reduce((s, r) => s + (r.Total || 0), 0);
    ws.addRow([label, 'NASIONAL', nasRows.length, nasTotal, nasRows.length > 0 ? 'OK ✓' : 'Kosong']);
    applyDataRowStyle(ws, rowNum, false, 0);
    setRingkasanAlign(ws, rowNum);
    rowNum++;

    for (const prov of PROVINCES) {
      const provName = toTitleCase(prov.name);
      const provRows = typeData[prov.name] || [];
      if (provRows.length === 0) continue;

      const provTotal = provRows.reduce((s, r) => s + (r.Total || 0), 0);
      ws.addRow([label, provName, provRows.length, provTotal, 'OK ✓']);
      applyDataRowStyle(ws, rowNum, false, 0);
      setRingkasanAlign(ws, rowNum);
      rowNum++;

      for (const kab of provRows) {
        if (!kab.name || kab.name.toLowerCase() === 'total') continue;
        const kabKey   = `${prov.name} > ${kab.name}`;
        const kecRows  = typeData[kabKey] || [];
        const kecTotal = kecRows.reduce((s, r) => s + (r.Total || 0), 0);
        const dispKey  = `${provName} > ${toTitleCase(kab.name)}`;
        ws.addRow([label, dispKey, kecRows.length, kecTotal, 'OK ✓']);
        applyDataRowStyle(ws, rowNum, false, 0);
        setRingkasanAlign(ws, rowNum);
        rowNum++;
      }
    }
  }

  ws.columns = [
    { width: 14 }, { width: 45 }, { width: 14 }, { width: 14 }, { width: 10 }
  ];
}

function buildRekapProvinsiSheet(wb, sheetName, typeLabel, commodity, year, nasData, opts) {
  const now = new Date().toLocaleString('id-ID');
  const ws  = wb.addWorksheet(sheetName, { properties: { tabColor: { argb: TAB_PROVINSI } } });

  addTitleBlock(ws,
    `REKAP ${typeLabel.toUpperCase()} PER PROVINSI — ${commodity.toUpperCase()} — TAHUN ${year}`,
    `Sumber: SIPDPS Kementan RI  |  Komoditas: ${commodity}  |  Dibuat: ${now}`,
    'Q'
  );

  ws.addRow(['No', 'ID Provinsi', 'Provinsi', ...MONTHS, 'Total']);
  applyHeaderStyle(ws, 4);
  if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: 4 }];
  if (opts.autoFilter)   ws.autoFilter = { from: 'A4', to: 'P4' };

  const dataStartRow = 5;
  let rowNum = dataStartRow;

  nasData.forEach((r, i) => {
    const bpsId    = PROV_BPS_MAP[r.name.toUpperCase()] || '';
    const rowTotal = MONTHS.reduce((s, m) => s + (r[m] || 0), 0);
    ws.addRow([i + 1, bpsId, toTitleCase(r.name), ...MONTHS.map(m => r[m] || 0), rowTotal]);
    applyDataRowStyle(ws, rowNum, false, 1);
    rowNum++;
  });

  const lastDataRow = rowNum - 1;
  const totalCells  = [
    null, null, 'TOTAL',
    ...MONTHS.map((_, idx) => {
      const col = String.fromCharCode(68 + idx);
      return { formula: `SUM(${col}${dataStartRow}:${col}${lastDataRow})` };
    }),
    { formula: `SUM(D${dataStartRow}:O${lastDataRow})` }
  ];
  ws.addRow(totalCells);
  applyDataRowStyle(ws, rowNum, true, 1);
  ws.getRow(rowNum).getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };

  ws.columns = [
    { width: 5 }, { width: 13 }, { width: 28 },
    ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
  ];
}

function buildRekapKabupatenSheet(wb, sheetName, typeLabel, commodity, year, allDataForType, opts) {
  const now = new Date().toLocaleString('id-ID');
  const ws  = wb.addWorksheet(sheetName, { properties: { tabColor: { argb: TAB_KABUPATEN } } });

  addTitleBlock(ws,
    `REKAP ${typeLabel.toUpperCase()} PER KABUPATEN/KOTA — ${commodity.toUpperCase()} — TAHUN ${year}`,
    `Sumber: SIPDPS Kementan RI  |  Komoditas: ${commodity}  |  Dibuat: ${now}`,
    'R'
  );

  ws.addRow(['No', 'ID Kab', 'ID Provinsi', 'Provinsi', 'Kabupaten/Kota', ...MONTHS, 'Total']);
  applyHeaderStyle(ws, 4);
  if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: 4 }];
  if (opts.autoFilter)   ws.autoFilter = { from: 'A4', to: 'R4' };

  const COL_TOTAL     = 'R';
  const dataStartRow  = 5;
  let globalNo = 1;
  let rowNum   = dataStartRow;
  const provRanges = [];

  for (const prov of PROVINCES) {
    const bpsId     = prov.bpsId;
    const kabRows   = allDataForType[prov.name] || [];
    const validRows = kabRows.filter(r => isValidAreaName(r.name));
    if (validRows.length === 0) continue;

    const provStartRow = rowNum;
    let kabSeq = 1;

    for (const r of validRows) {
      const kabId    = bpsId + String(kabSeq).padStart(2, '0');
      const rowTotal = MONTHS.reduce((s, m) => s + (r[m] || 0), 0);
      ws.addRow([globalNo, kabId, bpsId, toTitleCase(prov.name), toTitleCase(r.name), ...MONTHS.map(m => r[m] || 0), rowTotal]);
      applyDataRowStyle(ws, rowNum, false, 2);
      globalNo++; kabSeq++; rowNum++;
    }

    const provEndRow = rowNum - 1;
    ws.addRow([
      null, null, null, `Subtotal ${toTitleCase(prov.name)}`, null,
      ...MONTHS.map((_, idx) => {
        const col = String.fromCharCode(70 + idx);
        return { formula: `SUM(${col}${provStartRow}:${col}${provEndRow})` };
      }),
      { formula: `SUM(${COL_TOTAL}${provStartRow}:${COL_TOTAL}${provEndRow})` }
    ]);
    applySubtotalRowStyle(ws, rowNum, 4, 2);
    rowNum++;
    provRanges.push({ provName: prov.name, bpsId, startRow: provStartRow, endRow: provEndRow });
  }

  const grandTotalRow = [
    null, null, null, null, 'TOTAL NASIONAL',
    ...MONTHS.map((_, idx) => {
      const col = String.fromCharCode(70 + idx);
      return { formula: provRanges.map(p => `SUM(${col}${p.startRow}:${col}${p.endRow})`).join('+') || '0' };
    }),
    { formula: provRanges.map(p => `SUM(${COL_TOTAL}${p.startRow}:${COL_TOTAL}${p.endRow})`).join('+') || '0' }
  ];
  ws.addRow(grandTotalRow);
  applyDataRowStyle(ws, rowNum, true, 2);
  ws.getRow(rowNum).getCell(5).alignment = { vertical: 'middle', horizontal: 'left' };

  ws.columns = [
    { width: 5 }, { width: 10 }, { width: 12 }, { width: 26 }, { width: 28 },
    ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
  ];
}

function buildRekapKecamatanSheet(wb, sheetName, typeLabel, commodity, year, allDataForType, opts) {
  const now = new Date().toLocaleString('id-ID');
  const ws  = wb.addWorksheet(sheetName, { properties: { tabColor: { argb: TAB_KECAMATAN } } });

  addTitleBlock(ws,
    `REKAP ${typeLabel.toUpperCase()} PER KECAMATAN — ${commodity.toUpperCase()} — TAHUN ${year}`,
    `Sumber: SIPDPS Kementan RI  |  Komoditas: ${commodity}  |  Dibuat: ${now}`,
    'T'
  );

  ws.addRow(['No', 'ID Kecamatan', 'ID Kab', 'ID Provinsi', 'Provinsi', 'Kabupaten/Kota', 'Kecamatan', ...MONTHS, 'Total']);
  applyHeaderStyle(ws, 4);
  if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: 4 }];
  if (opts.autoFilter)   ws.autoFilter = { from: 'A4', to: 'T4' };

  const COL_TOTAL    = 'T';
  const dataStartRow = 5;
  let globalNo = 1;
  let rowNum   = dataStartRow;
  const provRanges = [];

  for (const prov of PROVINCES) {
    const bpsId        = prov.bpsId;
    const kabRows      = allDataForType[prov.name] || [];
    const validKabRows = kabRows.filter(r => isValidAreaName(r.name));
    if (validKabRows.length === 0) continue;

    const provStartRow = rowNum;
    let kabSeq = 1;

    for (const kab of validKabRows) {
      const kabId  = bpsId + String(kabSeq).padStart(2, '0');
      const kabKey = `${prov.name} > ${kab.name}`;
      const kecRows = (allDataForType[kabKey] || []).filter(k =>
        isValidAreaName(k.name) && !/^(total|jumlah|sub[\s-]?total|grand[\s-]?total)$/i.test(k.name)
      );

      let kecSeq = 1;
      for (const kec of kecRows) {
        const suffix     = String(kecSeq * 10).padStart(3, '0');
        const finalKecId = kabId + suffix;
        const rowTotal   = MONTHS.reduce((s, m) => s + (kec[m] || 0), 0);

        ws.addRow([
          globalNo, finalKecId, kabId, bpsId,
          toTitleCase(prov.name), toTitleCase(kab.name), kec.name,
          ...MONTHS.map(m => kec[m] || 0), rowTotal
        ]);
        applyDataRowStyle(ws, rowNum, false, 3);
        globalNo++; kecSeq++; rowNum++;
      }
      kabSeq++;
    }

    if (rowNum === provStartRow) continue;
    const provEndRow = rowNum - 1;

    ws.addRow([
      null, null, null, null, `Subtotal ${toTitleCase(prov.name)}`, null, null,
      ...MONTHS.map((_, idx) => {
        const col = String.fromCharCode(72 + idx);
        return { formula: `SUM(${col}${provStartRow}:${col}${provEndRow})` };
      }),
      { formula: `SUM(${COL_TOTAL}${provStartRow}:${COL_TOTAL}${provEndRow})` }
    ]);
    applySubtotalRowStyle(ws, rowNum, 5, 3);
    rowNum++;
    provRanges.push({ provName: prov.name, startRow: provStartRow, endRow: provEndRow });
  }

  ws.addRow([
    null, null, null, null, null, null, 'TOTAL NASIONAL',
    ...MONTHS.map((_, idx) => {
      const col = String.fromCharCode(72 + idx);
      return { formula: provRanges.map(p => `SUM(${col}${p.startRow}:${col}${p.endRow})`).join('+') || '0' };
    }),
    { formula: provRanges.map(p => `SUM(${COL_TOTAL}${p.startRow}:${COL_TOTAL}${p.endRow})`).join('+') || '0' }
  ]);
  applyDataRowStyle(ws, rowNum, true, 3);
  ws.getRow(rowNum).getCell(7).alignment = { vertical: 'middle', horizontal: 'left' };

  ws.columns = [
    { width: 5 }, { width: 13 }, { width: 10 }, { width: 12 },
    { width: 24 }, { width: 26 }, { width: 28 },
    ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
  ];
}

// ─────────────────────────────────────────────
// WORKBOOK BUILDERS (public API)
// ─────────────────────────────────────────────

async function buildExcelWorkbook(allData, params, opts) {
  const { year, commodity, types, scope } = params;
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'SIPDPS Harvester';
  wb.created  = wb.modified = new Date();
  wb.properties.date1904 = false;

  const typeLabels = { tanam: 'Luas Tanam', panen: 'Luas Panen', puso: 'Luas Puso' };

  if (opts.includeSummary !== false) {
    buildRingkasanSheet(wb, commodity, year, allData, types, opts);
  }

  for (const type of types) {
    const typeLabel = typeLabels[type] || type;
    const typeCode  = type === 'tanam' ? 'Tanam' : type === 'panen' ? 'Panen' : 'Puso';

    if (scope === 'semua') {
      const nasData = allData[type]['NASIONAL'] || [];
      buildRekapProvinsiSheet(wb, `${typeCode}_Rekap Provinsi`,  typeLabel, commodity, year, nasData,        opts);
      buildRekapKabupatenSheet(wb, `${typeCode}_Rekap Kabupaten`, typeLabel, commodity, year, allData[type], opts);
      buildRekapKecamatanSheet(wb, `${typeCode}_Rekap Kecamatan`, typeLabel, commodity, year, allData[type], opts);
    } else {
      const now = new Date().toLocaleString('id-ID');
      for (const [sheetKey, rows] of Object.entries(allData[type])) {
        if (sheetKey.endsWith('_TOTAL')) continue;
        const sheetKeyClean = sheetKey.replace(' > ', '_').replace(/[:\\/?*[\]]/g, '_');
        const isNasional    = sheetKey === 'NASIONAL';
        const isKab         = sheetKey.includes(' > ');
        const tabColor      = isNasional ? TAB_RINGKASAN : isKab ? TAB_KECAMATAN : TAB_KABUPATEN;

        let sheetName = `${typeCode}_${sheetKeyClean}`.substring(0, 31);
        let ws;
        try { ws = wb.addWorksheet(sheetName, { properties: { tabColor: { argb: tabColor } } }); }
        catch(e) { ws = wb.addWorksheet(sheetName + '_' + Date.now().toString().slice(-4)); }

        const mergeEndCol = isKab ? 'S' : 'Q';
        if (opts.includeMetadata !== false) {
          addTitleBlock(ws,
            `REKAP ${typeLabel.toUpperCase()} ${isKab ? 'KECAMATAN' : isNasional ? 'NASIONAL' : 'PROVINSI'} — ${commodity.toUpperCase()} — ${isNasional ? 'NASIONAL' : sheetKey} — TAHUN ${year}`,
            `Tahun: ${year} | Komoditas: ${commodity} | Sumber: SIPDPS Kementan RI | Dibuat: ${now}`,
            mergeEndCol
          );
        }

        const dataStart = 5;
        if (isKab) {
          const parts     = sheetKey.split(' > ');
          const bpsIdProv = PROV_BPS_MAP[parts[0].toUpperCase()] || '';
          ws.addRow(['No', 'ID Kecamatan', 'ID Kab', 'ID Provinsi', 'Provinsi', 'Kabupaten/Kota', 'Kecamatan', ...MONTHS, 'Total']);
          applyHeaderStyle(ws, 4);
          if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: dataStart - 1 }];
          let kabSeq = 1, primaryBase = 10;
          rows.forEach((r, i) => {
            if (!r.name || /^[\d.,\s]+$/.test(r.name)) return;
            const kabId = bpsIdProv + String(kabSeq).padStart(2, '0');
            const kecId = kabId + String(primaryBase).padStart(3, '0');
            primaryBase += 10;
            ws.addRow([i + 1, kecId, kabId, bpsIdProv, toTitleCase(parts[0]), toTitleCase(parts[1]), r.name, ...MONTHS.map(m => r[m] || 0)]);
            applyDataRowStyle(ws, dataStart + i, false, 3);
            kabSeq++;
          });
          ws.columns = [
            { width: 5 }, { width: 13 }, { width: 10 }, { width: 12 },
            { width: 24 }, { width: 26 }, { width: 28 },
            ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
          ];
        } else if (isNasional) {
          ws.addRow(['No', 'ID Provinsi', 'Provinsi', ...MONTHS, 'Total']);
          applyHeaderStyle(ws, 4);
          if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: dataStart - 1 }];
          rows.forEach((r, i) => {
            const bpsId = PROV_BPS_MAP[r.name.toUpperCase()] || '';
            ws.addRow([i + 1, bpsId, toTitleCase(r.name), ...MONTHS.map(m => r[m] || 0)]);
            applyDataRowStyle(ws, dataStart + i, false, 1);
          });
          ws.columns = [
            { width: 5 }, { width: 13 }, { width: 28 },
            ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
          ];
        } else {
          const bpsIdProv = PROV_BPS_MAP[sheetKey.toUpperCase()] || '';
          ws.addRow(['No', 'ID Kab', 'Kabupaten/Kota', ...MONTHS, 'Total']);
          applyHeaderStyle(ws, 4);
          if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: dataStart - 1 }];
          rows.forEach((r, i) => {
            const kabId = bpsIdProv + String(i + 1).padStart(2, '0');
            ws.addRow([i + 1, kabId, toTitleCase(r.name), ...MONTHS.map(m => r[m] || 0)]);
            applyDataRowStyle(ws, dataStart + i, false, 1);
          });
          ws.columns = [
            { width: 5 }, { width: 13 }, { width: 30 },
            ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
          ];
        }

        if (!isKab) {
          const lastDataRow  = dataStart + rows.length - 1;
          const totalRowNum  = lastDataRow + 1;
          const scrapedTotal = allData[type][`${sheetKey}_TOTAL`];
          ws.addRow([
            null, null, 'TOTAL',
            ...MONTHS.map(m => scrapedTotal ? scrapedTotal[m] || 0 : rows.reduce((s, r) => s + (r[m] || 0), 0))
          ]);
          applyDataRowStyle(ws, totalRowNum, true, isNasional ? 1 : 1);
          ws.getRow(totalRowNum).getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
        }
      }
    }
  }

  return wb;
}

async function buildExcelWorkbookMultiYear(allDataByYear, params, opts) {
  const { yearFrom, yearTo, years, commodity, types, scope } = params;
  const wb = new ExcelJS.Workbook();
  wb.creator  = 'SIPDPS Harvester';
  wb.created  = wb.modified = new Date();

  const now          = new Date().toLocaleString('id-ID');
  const typeLabels   = { tanam: 'Luas Tanam', panen: 'Luas Panen', puso: 'Luas Puso' };
  const yearRangeStr = `${yearFrom}–${yearTo}`;

  if (opts.includeSummary !== false) {
    const ws = wb.addWorksheet('RINGKASAN', { properties: { tabColor: { argb: TAB_RINGKASAN } } });

    ws.mergeCells('A1:F1');
    ws.getCell('A1').value     = `REKAP DATA SIPDPS — ${commodity.toUpperCase()} — ${yearRangeStr}`;
    ws.getCell('A1').font      = { bold: true, size: 14, name: 'Calibri' };
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height        = 28;

    ws.mergeCells('A2:F2');
    ws.getCell('A2').value     = `Tahun: ${yearRangeStr}  |  Komoditas: ${commodity}  |  Dibuat: ${now}`;
    ws.getCell('A2').font      = { size: 10, italic: true, name: 'Calibri' };
    ws.getCell('A2').alignment = { horizontal: 'center' };
    ws.getRow(2).height        = 18;
    ws.addRow([]);

    ws.addRow(['Tahun', 'Jenis Data', 'Wilayah', 'Jumlah Baris', 'Total (ha)', 'Status']);
    applyHeaderStyle(ws, 4);
    ws.getRow(4).height = 18;
    if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: 4 }];

    let rowNum = 5;
    for (const year of years) {
      for (const type of types) {
        const label    = typeLabels[type] || type;
        const typeData = allDataByYear[year]?.[type] || {};
        const nasRows  = typeData['NASIONAL'] || [];
        ws.addRow([year, label, 'NASIONAL', nasRows.length, nasRows.reduce((s, r) => s + (r.Total || 0), 0), nasRows.length > 0 ? 'OK ✓' : 'Kosong']);
        applyDataRowStyle(ws, rowNum, false, 0);
        ws.getRow(rowNum).height = 15;
        rowNum++;

        for (const prov of PROVINCES) {
          const provName = toTitleCase(prov.name);
          const provRows = typeData[prov.name] || [];
          if (provRows.length === 0) continue;
          ws.addRow([year, label, provName, provRows.length, provRows.reduce((s, r) => s + (r.Total || 0), 0), 'OK ✓']);
          applyDataRowStyle(ws, rowNum, false, 0);
          ws.getRow(rowNum).height = 15;
          rowNum++;

          for (const kab of provRows) {
            if (!kab.name || kab.name.toLowerCase() === 'total') continue;
            const kabKey  = `${prov.name} > ${kab.name}`;
            const kecRows = typeData[kabKey] || [];
            ws.addRow([year, label, `${provName} > ${toTitleCase(kab.name)}`, kecRows.length, kecRows.reduce((s, r) => s + (r.Total || 0), 0), 'OK ✓']);
            applyDataRowStyle(ws, rowNum, false, 0);
            ws.getRow(rowNum).height = 15;
            rowNum++;
          }
        }
      }
    }
    ws.columns = [
      { width: 8 }, { width: 14 }, { width: 45 }, { width: 14 }, { width: 14 }, { width: 10 }
    ];
  }

  for (const year of years) {
    for (const type of types) {
      const typeLabel = typeLabels[type] || type;
      const typeCode  = type === 'tanam' ? 'Tanam' : type === 'panen' ? 'Panen' : 'Puso';
      const yearData  = allDataByYear[year]?.[type] || {};

      if (scope === 'semua') {
        const nasData = yearData['NASIONAL'] || [];
        buildRekapProvinsiSheet(wb,  `${year}_${typeCode}_Nas`.substring(0, 31), typeLabel, commodity, year, nasData,   opts);
        buildRekapKabupatenSheet(wb, `${year}_${typeCode}_Kab`.substring(0, 31), typeLabel, commodity, year, yearData,  opts);
        buildRekapKecamatanSheet(wb, `${year}_${typeCode}_Kec`.substring(0, 31), typeLabel, commodity, year, yearData,  opts);
      } else {
        for (const [sheetKey, rows] of Object.entries(yearData)) {
          if (sheetKey.endsWith('_TOTAL')) continue;
          const keyClean   = sheetKey.replace(' > ', '_').replace(/[:\\/?*[\]]/g, '_');
          const isNasional = sheetKey === 'NASIONAL';
          const isKab      = sheetKey.includes(' > ');
          const tabColor   = isNasional ? TAB_RINGKASAN : isKab ? TAB_KECAMATAN : TAB_KABUPATEN;

          let sheetName = `${year}_${typeCode}_${keyClean}`.substring(0, 31);
          let ws;
          try { ws = wb.addWorksheet(sheetName, { properties: { tabColor: { argb: tabColor } } }); }
          catch(e) { ws = wb.addWorksheet(sheetName + '_' + Date.now().toString().slice(-4)); }

          const now2 = new Date().toLocaleString('id-ID');
          const mergeEndCol = isKab ? 'S' : 'Q';
          if (opts.includeMetadata !== false) {
            addTitleBlock(ws,
              `REKAP ${typeLabel.toUpperCase()} — ${commodity.toUpperCase()} — ${isNasional ? 'NASIONAL' : sheetKey} — TAHUN ${year}`,
              `Tahun: ${year} | Komoditas: ${commodity} | Sumber: SIPDPS Kementan RI | Dibuat: ${now2}`,
              mergeEndCol
            );
          }

          const dataStart = 5;
          if (isKab) {
            const parts     = sheetKey.split(' > ');
            const bpsIdProv = PROV_BPS_MAP[parts[0].toUpperCase()] || '';
            ws.addRow(['No', 'ID Kecamatan', 'ID Kab', 'ID Provinsi', 'Provinsi', 'Kabupaten/Kota', 'Kecamatan', ...MONTHS, 'Total']);
            applyHeaderStyle(ws, 4);
            if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: dataStart - 1 }];
            let kabSeq = 1, primaryBase = 10;
            rows.forEach((r, i) => {
              if (!isValidAreaName(r.name)) return;
              if (/^(total|jumlah|sub[\s-]?total|grand[\s-]?total)$/i.test(r.name)) return;
              const kabId = bpsIdProv + String(kabSeq).padStart(2, '0');
              const kecId = kabId + String(primaryBase).padStart(3, '0');
              primaryBase += 10;
              ws.addRow([i + 1, kecId, kabId, bpsIdProv, toTitleCase(parts[0]), toTitleCase(parts[1]), r.name, ...MONTHS.map(m => r[m] || 0)]);
              applyDataRowStyle(ws, dataStart + i, false, 3);
              kabSeq++;
            });
            ws.columns = [
              { width: 5 }, { width: 13 }, { width: 10 }, { width: 12 },
              { width: 24 }, { width: 26 }, { width: 28 },
              ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
            ];
          } else if (isNasional) {
            ws.addRow(['No', 'ID Provinsi', 'Provinsi', ...MONTHS, 'Total']);
            applyHeaderStyle(ws, 4);
            if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: dataStart - 1 }];
            rows.forEach((r, i) => {
              const bpsId = PROV_BPS_MAP[r.name.toUpperCase()] || '';
              ws.addRow([i + 1, bpsId, toTitleCase(r.name), ...MONTHS.map(m => r[m] || 0)]);
              applyDataRowStyle(ws, dataStart + i, false, 1);
            });
            ws.columns = [
              { width: 5 }, { width: 13 }, { width: 28 },
              ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
            ];
          } else {
            const bpsIdProv = PROV_BPS_MAP[sheetKey.toUpperCase()] || '';
            ws.addRow(['No', 'ID Kab', 'Kabupaten/Kota', ...MONTHS, 'Total']);
            applyHeaderStyle(ws, 4);
            if (opts.freezeHeader) ws.views = [{ state: 'frozen', ySplit: dataStart - 1 }];
            rows.forEach((r, i) => {
              const kabId = bpsIdProv + String(i + 1).padStart(2, '0');
              ws.addRow([i + 1, kabId, toTitleCase(r.name), ...MONTHS.map(m => r[m] || 0)]);
              applyDataRowStyle(ws, dataStart + i, false, 1);
            });
            ws.columns = [
              { width: 5 }, { width: 13 }, { width: 30 },
              ...MONTHS.map(() => ({ width: 8 })), { width: 11 }
            ];
          }

          if (!isKab) {
            const scrapedTotal = yearData[`${sheetKey}_TOTAL`];
            const totalRowNum  = dataStart + rows.length;
            ws.addRow([
              null, null, 'TOTAL',
              ...MONTHS.map(m => scrapedTotal ? scrapedTotal[m] || 0 : rows.reduce((s, r) => s + (r[m] || 0), 0))
            ]);
            applyDataRowStyle(ws, totalRowNum, true, 1);
            ws.getRow(totalRowNum).getCell(3).alignment = { vertical: 'middle', horizontal: 'left' };
          }
        }
      }
    }
  }

  return wb;
}

module.exports = { buildExcelWorkbook, buildExcelWorkbookMultiYear };
