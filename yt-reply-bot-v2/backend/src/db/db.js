const { Pool } = require('pg');
const config = require('../config');

const pool = new Pool({ connectionString: config.db.url });

async function query(text, params) {
  return pool.query(text, params);
}

/** Pacific-Time "today" as YYYY-MM-DD, matching YouTube's quota reset clock. */
function ptDateString(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Los_Angeles',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(d); // en-CA gives YYYY-MM-DD directly
}

async function getSetting(key, fallback = null) {
  const { rows } = await query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : fallback;
}

async function setSetting(key, value) {
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
    [key, String(value)]
  );
}

module.exports = { pool, query, ptDateString, getSetting, setSetting };
