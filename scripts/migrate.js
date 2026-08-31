'use strict';

const fs = require('fs');
const path = require('path');
const { getPool } = require('../db/pool');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  const pool = getPool();
  await pool.query(sql);
  console.log('✅ Schema applied (dnc_numbers, sync_log).');
  await pool.end();
}

main().catch((err) => {
  console.error('❌ Migration failed:', err);
  process.exitCode = 1;
});
