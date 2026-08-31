'use strict';

// Day N: daily Change List sync. Intended to run once/day post-8am ET via cron
// (see .github/workflows/dnc-daily-sync.yml). Safe to re-run — upserts on A,
// deletes on D are idempotent (spec: "Re-running a day's job after a partial failure").

const { getPool } = require('../db/pool');
const { fetchChangeList } = require('../lib/registryClient');
const { parseChangeListText } = require('../lib/parse');
const { applyChangeList, writeSyncLog, findStaleAreaCodes } = require('../lib/syncEngine');
const { SAN_AREA_CODES } = require('../lib/areaCodes');
const { postSlackMessage } = require('../lib/notify');

const MAX_STALE_DAYS = Number(process.env.DNC_MAX_STALE_DAYS || 31);
const RETRY_DELAY_MS = Number(process.env.DNC_RETRY_DELAY_MS || 5000);

async function alert(message) {
  console.error(`🚨 ALERT: ${message}`);
  await postSlackMessage(process.env.ALERT_WEBHOOK_URL, `DNC daily sync: ${message}`);
}

async function syncAreaCode(pool, areaCode, dateIso, attempt) {
  const text = await fetchChangeList(areaCode, dateIso);
  const rows = parseChangeListText(text);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { added, removed } = await applyChangeList(client, areaCode, rows);
    await writeSyncLog(client, {
      areaCode,
      fileType: 'change',
      added,
      removed,
      status: 'success',
      notes: attempt > 1 ? `succeeded on retry ${attempt}` : null,
    });
    await client.query('COMMIT');
    console.log(`[Sync] ${areaCode}: ✅ added=${added} removed=${removed}`);
    return { ok: true, added, removed };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function syncAreaCodeWithRetry(pool, areaCode, dateIso) {
  try {
    return await syncAreaCode(pool, areaCode, dateIso, 1);
  } catch (firstErr) {
    console.warn(`[Sync] ${areaCode}: attempt 1 failed (${firstErr.message}); retrying same-day`);
    await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
    try {
      return await syncAreaCode(pool, areaCode, dateIso, 2);
    } catch (secondErr) {
      // Spec: mark stale in sync_log and alert — do not silently proceed as if it synced.
      const client = await pool.connect();
      try {
        await writeSyncLog(client, {
          areaCode,
          fileType: 'change',
          added: 0,
          removed: 0,
          status: 'stale',
          notes: `retry failed: ${secondErr.message}`,
        });
      } finally {
        client.release();
      }
      await alert(`area code ${areaCode} failed to sync after retry: ${secondErr.message}`);
      return { ok: false, error: secondErr.message };
    }
  }
}

async function main() {
  const dateIso = new Date().toISOString().slice(0, 10);
  console.log(`🟢 Daily DNC Change List sync — ${dateIso}, ${SAN_AREA_CODES.length} area code(s)`);

  const pool = getPool();
  let successCount = 0;
  let failCount = 0;
  let totalAdded = 0;
  let totalRemoved = 0;

  for (const areaCode of SAN_AREA_CODES) {
    const result = await syncAreaCodeWithRetry(pool, areaCode, dateIso);
    if (result.ok) {
      successCount++;
      totalAdded += result.added;
      totalRemoved += result.removed;
    } else {
      failCount++;
    }
  }

  const stale = await findStaleAreaCodes(pool, SAN_AREA_CODES, MAX_STALE_DAYS);
  if (stale.length > 0) {
    for (const s of stale) {
      await alert(`area code ${s.areaCode} has not synced successfully in ${Math.floor(s.ageDays)} days (>${MAX_STALE_DAYS}d breaks safe harbor)`);
    }
  }

  await pool.end();

  console.log(`✅ Daily sync done — success=${successCount} failed=${failCount} stale=${stale.length} added=${totalAdded} removed=${totalRemoved}`);
  if (failCount > 0 || stale.length > 0) process.exitCode = 1;

  return { dateIso, successCount, failCount, staleCount: stale.length, totalAdded, totalRemoved };
}

module.exports = { main };

if (require.main === module) {
  main().catch((err) => {
    console.error('❌ Fatal error in daily_sync:', err);
    process.exitCode = 1;
  });
}
