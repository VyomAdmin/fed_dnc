#!/usr/bin/env node
'use strict';

// Writes DNC status back onto HubSpot contacts in a given list: checks each
// contact's phone/mobilephone against the local dnc_numbers table (kept in
// sync by daily_sync.js) and PATCHes dnc_opt_out=true onto matches only.
// Mirrors the dnc_opt_out convention from new_base_scrub.js — true when on
// the registry, left untouched (never fabricated/blanked) otherwise.
//
// Two run modes, same script:
//   - One-time full check (no --since): matches contacts against the entire
//     dnc_numbers table. Run once, right after the initial seed_full_list.js.
//   - Daily diff check (--since=YYYY-MM-DD, typically today): matches
//     contacts only against numbers added to dnc_numbers on/after that date
//     (dnc_numbers.added_at), i.e. just that day's Change List adds. Run
//     once/day after daily_sync.js so this stays a cheap incremental check
//     instead of a full re-scan.
//
// NOT wired to any schedule or trigger — invoke explicitly only.
//
// Usage: node scripts/hubspot_dnc_writeback.js [--list-id=1988] [--since=YYYY-MM-DD] [--dry-run]

const { getPool } = require('../db/pool');
const { fetchListMemberIds, batchReadContacts, batchUpdateContacts } = require('../lib/hubspotClient');

function parseArgs(argv) {
  const args = { listId: process.env.HUBSPOT_LIST_ID || '1988', sinceDate: null, dryRun: false };
  for (const a of argv) {
    if (a.startsWith('--list-id=')) args.listId = a.split('=')[1];
    else if (a.startsWith('--since=')) args.sinceDate = a.split('=')[1];
    else if (a === '--dry-run') args.dryRun = true;
  }
  return args;
}

function cleanPhone(raw) {
  if (!raw) return null;
  let p = String(raw).replace(/\D/g, '');
  if (p.length === 11 && p.startsWith('1')) p = p.slice(1);
  return p.length === 10 ? p : null;
}

async function findDncMatches(pool, contacts, sinceDate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('CREATE TEMP TABLE writeback_candidates (contact_id TEXT, area_code CHAR(3), number CHAR(7)) ON COMMIT DROP');

    const withPhone = contacts
      .map((c) => {
        const clean = cleanPhone(c.properties.phone || c.properties.mobilephone);
        return clean ? { id: c.id, areaCode: clean.slice(0, 3), number: clean.slice(3) } : null;
      })
      .filter(Boolean);

    for (let i = 0; i < withPhone.length; i += 1000) {
      const chunk = withPhone.slice(i, i + 1000);
      const values = [];
      const placeholders = chunk.map((c, j) => {
        values.push(c.id, c.areaCode, c.number);
        return `($${j * 3 + 1}, $${j * 3 + 2}, $${j * 3 + 3})`;
      });
      await client.query(
        `INSERT INTO writeback_candidates (contact_id, area_code, number) VALUES ${placeholders.join(', ')}`,
        values
      );
    }

    const dateFilter = sinceDate ? 'AND d.added_at >= $1' : '';
    const params = sinceDate ? [sinceDate] : [];
    const res = await client.query(
      `SELECT wc.contact_id FROM writeback_candidates wc
       JOIN dnc_numbers d ON d.area_code = wc.area_code AND d.number = wc.number
       WHERE TRUE ${dateFilter}`,
      params
    );
    await client.query('COMMIT');
    return new Set(res.rows.map((r) => r.contact_id));
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function main({ listId, sinceDate, dryRun } = {}) {
  const args = parseArgs(process.argv.slice(2));
  const opts = {
    listId: listId || args.listId,
    sinceDate: sinceDate !== undefined ? sinceDate : args.sinceDate,
    dryRun: dryRun ?? args.dryRun,
  };
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN;
  if (!token) throw new Error('Missing env HUBSPOT_PRIVATE_APP_TOKEN');

  console.log(`🟢 DNC write-back start — listId=${opts.listId} mode=${opts.sinceDate ? `diff since ${opts.sinceDate}` : 'full'} dryRun=${opts.dryRun}`);

  const memberIds = await fetchListMemberIds(token, opts.listId);
  console.log(`[List] total members: ${memberIds.length}`);
  if (memberIds.length === 0) { console.log('No members found.'); return { matched: 0, updated: 0 }; }

  const contacts = await batchReadContacts(token, memberIds, ['phone', 'mobilephone', 'dnc_opt_out']);
  console.log(`[HubSpot] fetched ${contacts.length} contact(s)`);

  const pool = getPool();
  let matches;
  try {
    matches = await findDncMatches(pool, contacts, opts.sinceDate);
  } finally {
    await pool.end();
  }
  console.log(`[Match] ${matches.size} contact(s) on National DNC${opts.sinceDate ? ` (added since ${opts.sinceDate})` : ''}`);

  const toUpdate = contacts
    .filter((c) => matches.has(c.id) && c.properties.dnc_opt_out !== 'true')
    .map((c) => ({ id: c.id, properties: { dnc_opt_out: 'true' } }));

  if (opts.dryRun) {
    console.log(`[DryRun] would update ${toUpdate.length} contact(s), no writes made.`);
    return { matched: matches.size, updated: 0 };
  }

  const updated = await batchUpdateContacts(token, toUpdate);
  console.log(`✅ DNC write-back done — matched=${matches.size} updated=${updated}`);
  return { matched: matches.size, updated };
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Fatal error in hubspot_dnc_writeback:', err);
    process.exitCode = 1;
  });
}
