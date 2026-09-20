// Tiny migration runner: applies schema.sql on boot. Idempotent (all
// statements use IF NOT EXISTS / ON CONFLICT), safe to run on every deploy.
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  await db.query(sql);
  console.log('[migrate] schema applied');
  await db.pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] failed', err);
  process.exit(1);
});
