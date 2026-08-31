'use strict';

// Day 0: one-time Full List seed. Ops-run job, not part of the daily cron — re-run only
// for a newly-added area code, or a full rebuild after an incident.
//
// Usage:
//   node scripts/seed_full_list.js                 seed all 34 subscribed area codes
//   node scripts/seed_full_list.js 407 813          seed only these area codes

const { getPool } = require('../db/pool');
const { fetchFullList } = require('../lib/registryClient');
const { parseFullListText } = require('../lib/parse');
const { applyFullList, writeSyncLog } = require('../lib/syncEngine');
const { SAN_AREA_CODES } = require('../lib/areaCodes');

async function seedAreaCode(pool, areaCode) {
  console.log(`[Seed] ${areaCode}: fetching Full List...`);
  try {
    const text = await fetchFullList(areaCode);
    const rows = parseFullListText(text).filter((r) => r.areaCode === areaCode);
    console.log(`[Seed] ${areaCode}: ${rows.length} numbers parsed`);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { added } = await applyFullList(client, areaCode, rows);
      await writeSyncLog(client, {
        areaCode,
        fileType: 'full',
        added,
        removed: 0,
        status: 'success',
        notes: `${rows.length} numbers in file`,
      });
      await client.query('COMMIT');
      console.log(`[Seed] ${areaCode}: ✅ added ${added} (of ${rows.length} parsed)`);
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(`[Seed] ${areaCode}: ❌ ${err.message}`);
    const client = await pool.connect();
    try {
      await writeSyncLog(client, {
        areaCode,
        fileType: 'full',
        added: 0,
        removed: 0,
        status: 'failed',
        notes: err.message,
      });
    } finally {
      client.release();
    }
    return false;
  }
  return true;
}

async function main(areaCodesArg) {
  const areaCodes = (areaCodesArg && areaCodesArg.length)
    ? areaCodesArg
    : (process.argv.slice(2).length ? process.argv.slice(2) : SAN_AREA_CODES);
  console.log(`🟢 Seeding Full List for ${areaCodes.length} area code(s): ${areaCodes.join(', ')}`);

  const pool = getPool();
  let failures = 0;
  for (const areaCode of areaCodes) {
    const ok = await seedAreaCode(pool, areaCode);
    if (!ok) failures++;
  }
  await pool.end();

  console.log(failures === 0 ? '✅ Seed complete, all area codes succeeded.' : `⚠️ Seed complete with ${failures} failure(s) — see sync_log.`);
  if (failures > 0) process.exitCode = 1;
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Fatal error in seed_full_list:', err);
    process.exitCode = 1;
  });
}
