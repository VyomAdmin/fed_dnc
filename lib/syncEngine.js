'use strict';

// DB-shaped logic, decoupled from pg so it's unit-testable with a fake client
// ({ query(sql, params) => Promise<{rowCount}> }).

function chunkArray(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Day 0 seed: bulk insert a Full List for one area code. Idempotent — a re-run
 *  ignores rows already present rather than erroring. */
async function applyFullList(client, areaCode, rows) {
  let added = 0;
  for (const chunk of chunkArray(rows, 1000)) {
    const values = [];
    const placeholders = chunk.map((r, i) => {
      values.push(r.areaCode, r.number);
      return `($${i * 2 + 1}, $${i * 2 + 2})`;
    });
    const res = await client.query(
      `INSERT INTO dnc_numbers (area_code, number) VALUES ${placeholders.join(', ')}
       ON CONFLICT (area_code, number) DO NOTHING`,
      values
    );
    added += res.rowCount || 0;
  }
  return { added, removed: 0 };
}

/** Day N sync: apply a Change List for one area code, in timestamp order.
 *  A -> upsert (idempotent), D -> delete. Rows must already be sorted ascending
 *  by timestamp (parseChangeListText does this) so a later D always wins over
 *  an earlier A for the same number within one run. */
async function applyChangeList(client, areaCode, rows) {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.transaction === 'A') {
      const res = await client.query(
        `INSERT INTO dnc_numbers (area_code, number) VALUES ($1, $2)
         ON CONFLICT (area_code, number) DO NOTHING`,
        [row.areaCode, row.number]
      );
      added += res.rowCount || 0;
    } else if (row.transaction === 'D') {
      const res = await client.query(
        `DELETE FROM dnc_numbers WHERE area_code = $1 AND number = $2`,
        [row.areaCode, row.number]
      );
      removed += res.rowCount || 0;
    }
  }
  return { added, removed };
}

async function writeSyncLog(client, { areaCode, fileType, added, removed, status, notes }) {
  await client.query(
    `INSERT INTO sync_log (area_code, file_type, records_added, records_removed, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [areaCode, fileType, added, removed, status, notes || null]
  );
}

/** Safe-harbor guard from the spec: a stale area code beyond 31 days breaks safe harbor. */
async function findStaleAreaCodes(client, areaCodes, maxStaleDays = 31) {
  const res = await client.query(
    `SELECT area_code, MAX(run_date) AS last_success
     FROM sync_log
     WHERE status = 'success' AND area_code = ANY($1::char(3)[])
     GROUP BY area_code`,
    [areaCodes]
  );
  const lastSuccess = new Map(res.rows.map((r) => [r.area_code, new Date(r.last_success)]));
  const now = Date.now();
  const stale = [];
  for (const ac of areaCodes) {
    const last = lastSuccess.get(ac);
    const ageDays = last ? (now - last.getTime()) / 86400000 : Infinity;
    if (ageDays > maxStaleDays) stale.push({ areaCode: ac, ageDays });
  }
  return stale;
}

module.exports = { applyFullList, applyChangeList, writeSyncLog, findStaleAreaCodes, chunkArray };
