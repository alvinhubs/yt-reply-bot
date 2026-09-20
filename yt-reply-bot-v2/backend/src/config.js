require('dotenv').config();

function required(name) {
  const v = process.env[name];
  if (!v && process.env.NODE_ENV !== 'test') {
    console.warn(`[config] Warning: ${name} is not set`);
  }
  return v;
}

module.exports = {
  youtube: {
    clientId: required('YT_CLIENT_ID'),
    clientSecret: required('YT_CLIENT_SECRET'),
    refreshToken: required('YT_REFRESH_TOKEN'),
    channelId: required('YT_CHANNEL_ID'),
  },
  anthropic: {
    apiKey: required('ANTHROPIC_API_KEY'),
  },
  db: {
    url: required('DATABASE_URL'),
  },
  redis: {
    url: required('REDIS_URL'),
  },
  scan: {
    // Stored default; the live value lives in the `settings` table and can be
    // changed from the dashboard without a redeploy.
    defaultIntervalMinutes: Number(process.env.SCAN_INTERVAL_MINUTES || 15),
  },
  quota: {
    dailyBudget: Number(process.env.DAILY_UNIT_BUDGET || 500000),
    autoPauseAt: Number(process.env.AUTO_PAUSE_AT_UNITS || 450000),
  },
  posting: {
    delayMs: Number(process.env.REPLY_POST_DELAY_MS || 1500),
  },
  port: Number(process.env.PORT || 3000),
};
