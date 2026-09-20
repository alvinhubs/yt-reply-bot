const { Queue } = require('bullmq');
const { connection } = require('./jobs/queue');
const { scanAllActiveVideos } = require('./jobs/scanJob');
const db = require('./db/db');

const scanQueue = new Queue('scan-schedule', { connection });
const SCHEDULER_JOB_NAME = 'periodic-scan';

async function applyIntervalFromSettings() {
  const minutes = Number(await db.getSetting('scan_interval_minutes', 15));
  await scanQueue.removeRepeatable(SCHEDULER_JOB_NAME, { every: 60_000 }).catch(() => {});
  // Clear any existing repeatable schedules for this job before re-adding.
  const existing = await scanQueue.getRepeatableJobs();
  for (const job of existing) {
    if (job.name === SCHEDULER_JOB_NAME) {
      await scanQueue.removeRepeatableByKey(job.key);
    }
  }
  await scanQueue.add(
    SCHEDULER_JOB_NAME,
    {},
    { repeat: { every: minutes * 60_000 }, removeOnComplete: true, removeOnFail: true }
  );
  console.log(`[scheduler] Scanning every ${minutes} minute(s).`);
}

/** Call once at startup, and again whenever the dashboard changes the interval. */
async function initScheduler() {
  await applyIntervalFromSettings();
}

const { Worker } = require('bullmq');
const scanWorker = new Worker(
  'scan-schedule',
  async () => {
    const enabled = (await db.getSetting('bot_enabled', 'true')) === 'true';
    if (!enabled) return { skipped: true, reason: 'bot disabled' };
    return scanAllActiveVideos();
  },
  { connection }
);

module.exports = { initScheduler, applyIntervalFromSettings, scanWorker };
