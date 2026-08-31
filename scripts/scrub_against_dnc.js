#!/usr/bin/env node
'use strict';

// Monthly/campaign scrub against the local dnc_numbers table — the anti-join from the
// spec, run right before each campaign push. Cheap because dnc_numbers is always <=24h
// stale thanks to daily_sync.js; no live registry lookup happens here.
//
// Usage:
//   node scripts/scrub_against_dnc.js contacts.csv [--phone-col=phone] [--out-dir=.]
//
// Input CSV needs one column with a 10-digit US phone number (default column: "phone").
// Writes two files next to --out-dir: <name>.callable.csv (survivors) and
// <name>.suppressed.csv (on the DNC list, with the reason).

const fs = require('fs');
const path = require('path');
const { getPool } = require('../db/pool');
const { SAN_AREA_CODES } = require('../lib/areaCodes');

const SAN_SET = new Set(SAN_AREA_CODES);

// Same minimal CSV parser as hubspot-import-contacts.js — handles quoted fields with
// embedded commas/newlines.
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else if (c === '"') { inQuotes = true; }
    else if (c === ',') { pushField(); }
    else if (c === '\n') { pushRow(); }
    else if (c === '\r') { /* skip */ }
    else { field += c; }
  }
  if (field.length > 0 || row.length > 0) pushRow();
  const nonEmptyRows = rows.filter((r) => r.length > 1 || r[0] !== '');
  const [header, ...dataRows] = nonEmptyRows;
  return { header, rows: dataRows };
}

function toCsvField(value) {
  const s = value == null ? '' : String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function writeCsv(filePath, header, rows) {
  const lines = [header.map(toCsvField).join(',')];
  for (const row of rows) lines.push(row.map(toCsvField).join(','));
  fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
}

function cleanPhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('1')) p = p.slice(1);
  return p.length === 10 ? p : null;
}

function parseArgs(argv) {
  const args = { file: null, phoneCol: 'phone', outDir: '.' };
  for (const a of argv) {
    if (a.startsWith('--phone-col=')) args.phoneCol = a.split('=')[1];
    else if (a.startsWith('--out-dir=')) args.outDir = a.split('=')[1];
    else if (!args.file) args.file = a;
  }
  return args;
}

async function main() {
  const { file, phoneCol, outDir } = parseArgs(process.argv.slice(2));
  if (!file) throw new Error('Usage: node scripts/scrub_against_dnc.js <contacts.csv> [--phone-col=phone] [--out-dir=.]');

  const text = fs.readFileSync(file, 'utf8');
  const { header, rows } = parseCsv(text);
  const phoneIdx = header.indexOf(phoneCol);
  if (phoneIdx === -1) throw new Error(`Column "${phoneCol}" not found in CSV header: ${header.join(', ')}`);

  console.log(`[Scrub] ${rows.length} row(s) loaded, phone column="${phoneCol}"`);

  const pool = getPool();
  const client = await pool.connect();
  try {
    // Bulk-load the candidate numbers into a temp table, then anti-join against
    // dnc_numbers in one query instead of one round-trip per row.
    await client.query('BEGIN');
    await client.query(`CREATE TEMP TABLE scrub_candidates (row_idx INT, area_code CHAR(3), number CHAR(7)) ON COMMIT DROP`);

    const candidates = rows.map((row, i) => {
      const clean = cleanPhone(row[phoneIdx]);
      return clean ? { rowIdx: i, areaCode: clean.slice(0, 3), number: clean.slice(3) } : null;
    });

    const withPhone = candidates.filter(Boolean);
    for (let i = 0; i < withPhone.length; i += 1000) {
      const chunk = withPhone.slice(i, i + 1000);
      const values = [];
      const placeholders = chunk.map((c, j) => {
        values.push(c.rowIdx, c.areaCode, c.number);
        return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`;
      });
      await client.query(
        `INSERT INTO scrub_candidates (row_idx, area_code, number) VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    const dncRes = await client.query(
      `SELECT sc.row_idx FROM scrub_candidates sc
       JOIN dnc_numbers d ON d.area_code = sc.area_code AND d.number = sc.number`
    );
    const dncRowIdx = new Set(dncRes.rows.map((r) => r.row_idx));
    await client.query('COMMIT');

    const callable = [];
    const suppressed = [];
    rows.forEach((row, i) => {
      const clean = cleanPhone(row[phoneIdx]);
      if (!clean) { suppressed.push([...row, 'INVALID_PHONE']); return; }
      const areaCode = clean.slice(0, 3);
      if (dncRowIdx.has(i)) { suppressed.push([...row, 'ON_NATIONAL_DNC']); return; }
      if (!SAN_SET.has(areaCode)) { suppressed.push([...row, 'OUT_OF_SAN_COVERAGE']); return; }
      callable.push(row);
    });

    const base = path.basename(file, path.extname(file));
    const callablePath = path.join(outDir, `${base}.callable.csv`);
    const suppressedPath = path.join(outDir, `${base}.suppressed.csv`);
    writeCsv(callablePath, header, callable);
    writeCsv(suppressedPath, [...header, 'suppress_reason'], suppressed);

    console.log(`[Scrub] callable=${callable.length} suppressed=${suppressed.length}`);
    console.log(`[Scrub] wrote ${callablePath}`);
    console.log(`[Scrub] wrote ${suppressedPath}`);
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error('❌ Fatal error in scrub_against_dnc:', err);
  process.exitCode = 1;
});
