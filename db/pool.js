'use strict';

const { Pool } = require('pg');

// RDS Postgres. Prefer DATABASE_URL (postgres://user:pass@host:5432/dbname);
// falls back to discrete PG* vars if that's how creds get provided.
// RDS requires TLS by default and typically presents a chain not in Node's
// trust store, so we verify-if-provided but don't hard-fail without a CA —
// set PGSSLROOTCERT to the RDS bundle for full chain verification in prod.
const connectionString = process.env.DATABASE_URL || undefined;

function buildSsl() {
  if (String(process.env.PGSSL || '').toLowerCase() === 'false') return false;
  const ca = process.env.PGSSLROOTCERT
    ? require('fs').readFileSync(process.env.PGSSLROOTCERT, 'utf8')
    : undefined;
  return { rejectUnauthorized: Boolean(ca), ca };
}

let pool;

function getPool() {
  if (pool) return pool;
  pool = new Pool({
    connectionString,
    host: connectionString ? undefined : process.env.PGHOST,
    port: connectionString ? undefined : Number(process.env.PGPORT || 5432),
    user: connectionString ? undefined : process.env.PGUSER,
    password: connectionString ? undefined : process.env.PGPASSWORD,
    database: connectionString ? undefined : process.env.PGDATABASE,
    ssl: buildSsl(),
    max: Number(process.env.PGPOOL_MAX || 5),
  });
  return pool;
}

module.exports = { getPool };
