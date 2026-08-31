'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyFullList, applyChangeList } = require('../lib/syncEngine');

// Minimal in-memory stand-in for the pg client, just enough to exercise the
// INSERT ON CONFLICT DO NOTHING / DELETE patterns syncEngine.js issues —
// keeps these tests fast and DB-free.
function makeFakeClient() {
  const rows = new Set(); // "areaCode:number"
  return {
    rows,
    async query(sql, params) {
      if (sql.startsWith('INSERT')) {
        let added = 0;
        for (let i = 0; i < params.length; i += 2) {
          const key = `${params[i]}:${params[i + 1]}`;
          if (!rows.has(key)) { rows.add(key); added++; }
        }
        return { rowCount: added };
      }
      if (sql.startsWith('DELETE')) {
        const key = `${params[0]}:${params[1]}`;
        const existed = rows.delete(key);
        return { rowCount: existed ? 1 : 0 };
      }
      throw new Error(`unexpected SQL in fake client: ${sql}`);
    },
  };
}

test('applyFullList inserts all rows once, ignores duplicates on re-run', async () => {
  const client = makeFakeClient();
  const rows = [
    { areaCode: '407', number: '5551234' },
    { areaCode: '813', number: '5559999' },
  ];
  const first = await applyFullList(client, '407', rows);
  assert.equal(first.added, 2);
  assert.equal(client.rows.size, 2);

  const second = await applyFullList(client, '407', rows); // re-seed
  assert.equal(second.added, 0);
  assert.equal(client.rows.size, 2);
});

test('applyChangeList: A upserts, D deletes, idempotent on rerun', async () => {
  const client = makeFakeClient();
  const rows = [
    { areaCode: '407', number: '5551234', transaction: 'A', timestamp: new Date('2026-08-29T08:00:00Z') },
    { areaCode: '813', number: '5559999', transaction: 'A', timestamp: new Date('2026-08-29T08:01:00Z') },
  ];
  const first = await applyChangeList(client, '407', rows);
  assert.equal(first.added, 2);
  assert.equal(first.removed, 0);
  assert.equal(client.rows.size, 2);

  const deleteRow = [{ areaCode: '407', number: '5551234', transaction: 'D', timestamp: new Date('2026-08-30T08:00:00Z') }];
  const second = await applyChangeList(client, '407', deleteRow);
  assert.equal(second.removed, 1);
  assert.equal(client.rows.size, 1);

  // Re-running the same delete after it already happened is a no-op, not an error.
  const third = await applyChangeList(client, '407', deleteRow);
  assert.equal(third.removed, 0);
});

test('applyChangeList: a later D beats an earlier A for the same number in one run', async () => {
  const client = makeFakeClient();
  const rows = [
    { areaCode: '407', number: '5551234', transaction: 'A', timestamp: new Date('2026-08-29T08:00:00Z') },
    { areaCode: '407', number: '5551234', transaction: 'D', timestamp: new Date('2026-08-29T09:00:00Z') },
  ];
  await applyChangeList(client, '407', rows);
  assert.equal(client.rows.size, 0);
});
