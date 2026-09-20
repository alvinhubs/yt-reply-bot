const db = require('../db/db');
const config = require('../config');

/**
 * Records unit spend against today's (Pacific Time) usage row.
 * Call this immediately after every YouTube API call, with the unit cost
 * for that specific method (see the YouTube Data API quota calculator —
 * costs are fixed per method, e.g. comments.insert = 50, *.list = 1).
 */
async function spend(units, label = '') {
  const date = db.ptDateString();
  await db.query(
    `INSERT INTO quota_usage (usage_date, units_used) VALUES ($1, $2)
     ON CONFLICT (usage_date) DO UPDATE SET units_used = quota_usage.units_used + $2`,
    [date, units]
  );
  if (process.env.QUOTA_LOG === 'verbose') {
    console.log(`[quota] +${units} (${label})`);
  }
}

async function getTodayUsage() {
  const date = db.ptDateString();
  const { rows } = await db.query(
    'SELECT units_used FROM quota_usage WHERE usage_date = $1',
    [date]
  );
  return rows[0] ? rows[0].units_used : 0;
}

/**
 * Returns false once today's usage crosses the auto-pause threshold, so the
 * scheduler/worker can stop posting *before* actually hitting a 403.
 * Threshold is read from settings (dashboard-editable) with the .env value
 * as a fallback default.
 */
async function canSpend(units) {
  const threshold = Number(
    await db.getSetting('auto_pause_at_units', config.quota.autoPauseAt)
  );
  const used = await getTodayUsage();
  return used + units <= threshold;
}

module.exports = { spend, getTodayUsage, canSpend };
