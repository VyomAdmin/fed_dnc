#!/usr/bin/env node
/**
 * hubspot-import-contacts.js
 *
 * Reads contact records from a CSV file (or every .csv in a folder) and
 * pushes them to HubSpot via the CRM v3 batch create endpoint.
 *
 * Contacts created this way are non-marketing by default: hs_marketable_status
 * is a read-only HubSpot property and is never set in this script, so there's
 * nothing to accidentally flip.
 *
 * Usage:
 *   HUBSPOT_ACCESS_TOKEN=xxx node hubspot-import-contacts.js /full/local/path
 *
 * The path can be a single CSV file or a folder containing CSV files.
 * Requires Node.js 18+ (uses the built-in fetch).
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---- Config -------------------------------------------------------------

const BATCH_SIZE = 100;                // HubSpot batch create max per call
const DELAY_MS_BETWEEN_BATCHES = 150;  // throttle to stay under rate limits
const MAX_RETRIES = 5;

// Map your CSV header names (left) to HubSpot internal property names (right).
// Standard fields (firstname, lastname, address, city, phone, email) are
// guaranteed correct. The custom fields (osr_id__c, install_state__c,
// install_zip__c, leadsource, phone_number, policy_effective_date,
// policy_card__c) are mapped assuming their HubSpot internal name matches
// the CSV header exactly, per your prior 43-column mapping work.
// VERIFY these against Settings > Properties before running at scale —
// I don't have live access to your portal's property list in this session.
const COLUMN_MAP = {
  osr_id__c: 'osr_id__c',
  'First Name': 'firstname',
  'Last Name': 'lastname',
  address: 'address',
  City: 'city',
  install_state__c: 'install_state__c',
  install_zip__c: 'install_zip__c',
  phone: 'phone',
  Email: 'email',
  leadsource: 'leadsource',
  phone_number: 'phone_number',
  policy_effective_date: 'policy_effective_date',
  policy_card__c: 'policy_card__c',
};

const REQUIRED_PROPERTY = 'email'; // rows missing this are skipped, not sent

// HubSpot "date" type properties require midnight UTC as a millisecond
// timestamp, not a plain date string. List any date-type custom properties
// here so their values get converted automatically. If policy_effective_date
// is actually a single-line text property in your portal (not a date
// property), remove it from this list.
const DATE_PROPERTIES = ['policy_effective_date'];

// ---- Entry point ----------------------------------------------------------

const DRY_RUN_PREVIEW_COUNT = 5;

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const inputPath = args.find((a) => !a.startsWith('--'));

  if (!inputPath) {
    console.error('Usage: node hubspot-import-contacts.js /full/local/path [--dry-run]');
    process.exit(1);
  }

  const token = process.env.HUBSPOT_ACCESS_TOKEN;
  if (!token && !dryRun) {
    console.error('Missing HUBSPOT_ACCESS_TOKEN environment variable.');
    process.exit(1);
  }

  const absPath = path.resolve(inputPath);
  if (!fs.existsSync(absPath)) {
    console.error(`Path not found: ${absPath}`);
    process.exit(1);
  }

  const files = getCsvFiles(absPath);
  if (files.length === 0) {
    console.error('No CSV files found at the given path.');
    process.exit(1);
  }

  if (dryRun) {
    console.log(`[DRY RUN] No data will be sent to HubSpot.\n`);
    let shown = 0;
    for (const file of files) {
      console.log(`Reading ${file}`);
      const rows = parseCsv(fs.readFileSync(file, 'utf8'));
      const { records, skippedCount } = mapRecords(rows);
      console.log(`  ${records.length} mappable rows, ${skippedCount} skipped (missing email)\n`);

      for (const record of records) {
        if (shown >= DRY_RUN_PREVIEW_COUNT) break;
        console.log(`--- Preview record ${shown + 1} ---`);
        console.log(JSON.stringify(record, null, 2));
        shown++;
      }
      if (shown >= DRY_RUN_PREVIEW_COUNT) break;
    }
    console.log(`\n[DRY RUN] Shown ${shown} of ${DRY_RUN_PREVIEW_COUNT} requested preview records.`);
    console.log('Check property names and the policy_effective_date value above against');
    console.log('Settings > Properties before running for real (drop --dry-run to send).');
    return;
  }

  const failedRows = [];
  let created = 0;
  let skipped = 0;
  let errored = 0;

  for (const file of files) {
    console.log(`\nReading ${file}`);
    const rows = parseCsv(fs.readFileSync(file, 'utf8'));
    const { records, skippedCount } = mapRecords(rows);
    skipped += skippedCount;

    const batches = chunk(records, BATCH_SIZE);
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      try {
        await pushBatch(batch, token);
        created += batch.length;
        console.log(`  Batch ${i + 1}/${batches.length}: ${batch.length} contacts created`);
      } catch (err) {
        errored += batch.length;
        console.error(`  Batch ${i + 1}/${batches.length} failed: ${err.message}`);
        failedRows.push(...batch.map((r) => ({ ...r.properties, error: err.message })));
      }
      await sleep(DELAY_MS_BETWEEN_BATCHES);
    }
  }

  if (failedRows.length > 0) {
    const failedPath = path.join(path.dirname(files[0]), 'failed-rows.csv');
    writeCsv(failedPath, failedRows);
    console.log(`\nWrote ${failedRows.length} failed rows to ${failedPath} for review/retry`);
  }

  console.log(
    `\nDone. Created: ${created} | Skipped (missing email): ${skipped} | Errored: ${errored}`
  );
}

// ---- Helpers ----------------------------------------------------------

function getCsvFiles(absPath) {
  const stat = fs.statSync(absPath);
  if (stat.isDirectory()) {
    return fs
      .readdirSync(absPath)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .map((f) => path.join(absPath, f));
  }
  return [absPath];
}

function mapRecords(rows) {
  const records = [];
  let skippedCount = 0;

  for (const row of rows) {
    const properties = {};
    for (const [csvHeader, hsProperty] of Object.entries(COLUMN_MAP)) {
      if (row[csvHeader] !== undefined && row[csvHeader] !== '') {
        const value = row[csvHeader].trim();
        properties[hsProperty] = DATE_PROPERTIES.includes(hsProperty)
          ? toHubSpotDateMs(value)
          : value;
      }
    }
    if (!properties[REQUIRED_PROPERTY]) {
      skippedCount++;
      continue;
    }
    records.push({ properties });
  }

  return { records, skippedCount };
}

async function pushBatch(batch, token, attempt = 1) {
  const res = await fetch('https://api.hubapi.com/crm/v3/objects/contacts/batch/create', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ inputs: batch }),
  });

  if (res.status === 429 && attempt <= MAX_RETRIES) {
    const retryAfter = Number(res.headers.get('retry-after')) || attempt * 2;
    await sleep(retryAfter * 1000);
    return pushBatch(batch, token, attempt + 1);
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 300)}`);
  }

  return res.json();
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Converts a date string to the midnight-UTC millisecond timestamp HubSpot
// date properties require. Handles DD-MM-YYYY explicitly (e.g. "25-06-2026")
// since JavaScript's native Date() parses that format unreliably/incorrectly.
// Falls back to native parsing for other formats (e.g. "2026-06-25").
function toHubSpotDateMs(value) {
  const ddmmyyyy = value.match(/^(\d{1,2})-(\d{1,2})-(\d{4})$/);
  if (ddmmyyyy) {
    const [, day, month, year] = ddmmyyyy;
    return String(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  }

  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) return value;
  return String(Date.UTC(parsed.getUTCFullYear(), parsed.getUTCMonth(), parsed.getUTCDate()));
}

// Minimal CSV parser — handles quoted fields with embedded commas/newlines.
// For files with unusual encodings or heavily malformed quoting, clean the
// file first (e.g. re-save from Excel/Sheets as UTF-8 CSV).
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;

  const pushField = () => {
    row.push(field);
    field = '';
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      pushField();
    } else if (c === '\n') {
      pushRow();
    } else if (c === '\r') {
      // skip
    } else {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) pushRow();

  const nonEmptyRows = rows.filter((r) => r.length > 1 || r[0] !== '');
  const [header, ...dataRows] = nonEmptyRows;
  return dataRows.map((r) => header.reduce((obj, key, idx) => ({ ...obj, [key]: r[idx] }), {}));
}

function writeCsv(filePath, records) {
  if (records.length === 0) return;
  const headers = Object.keys(records[0]);
  const lines = [headers.join(',')];
  for (const rec of records) {
    lines.push(headers.map((h) => `"${String(rec[h] ?? '').replace(/"/g, '""')}"`).join(','));
  }
  fs.writeFileSync(filePath, lines.join('\n'));
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});