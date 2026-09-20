const express = require('express');
const db = require('../db/db');
const { getTodayUsage } = require('../youtube/quota');
const { scanVideo, scanAllActiveVideos } = require('../jobs/scanJob');
const { applyIntervalFromSettings } = require('../scheduler');
const { getVideoTitle } = require('../youtube/client');

const router = express.Router();

// --- Status / quota ---
router.get('/status', async (req, res) => {
  const [used, interval, autoPauseAt, enabled] = await Promise.all([
    getTodayUsage(),
    db.getSetting('scan_interval_minutes', 15),
    db.getSetting('auto_pause_at_units', 450000),
    db.getSetting('bot_enabled', 'true'),
  ]);
  res.json({
    unitsUsedToday: used,
    autoPauseAtUnits: Number(autoPauseAt),
    scanIntervalMinutes: Number(interval),
    botEnabled: enabled === 'true',
  });
});

router.post('/settings/enabled', async (req, res) => {
  await db.setSetting('bot_enabled', req.body.enabled ? 'true' : 'false');
  res.json({ ok: true });
});

router.post('/settings/interval', async (req, res) => {
  const minutes = Number(req.body.minutes);
  if (!minutes || minutes < 1) return res.status(400).json({ error: 'minutes must be >= 1' });
  await db.setSetting('scan_interval_minutes', minutes);
  await applyIntervalFromSettings();
  res.json({ ok: true, minutes });
});

router.post('/settings/auto-pause', async (req, res) => {
  const units = Number(req.body.units);
  if (!units || units < 0) return res.status(400).json({ error: 'units must be >= 0' });
  await db.setSetting('auto_pause_at_units', units);
  res.json({ ok: true, units });
});

// --- Videos ---
router.get('/videos', async (req, res) => {
  const { rows } = await db.query(
    `SELECT v.video_id, v.title, v.is_active, v.last_scanned_at,
            (SELECT count(*) FROM replied_threads r WHERE r.video_id = v.video_id) AS replied_count
     FROM videos v ORDER BY v.added_at DESC`
  );
  res.json(rows);
});

router.post('/videos', async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: 'videoId required' });
  const title = await getVideoTitle(videoId);
  await db.query(
    `INSERT INTO videos (video_id, title) VALUES ($1, $2)
     ON CONFLICT (video_id) DO UPDATE SET title = EXCLUDED.title, is_active = true`,
    [videoId, title]
  );
  res.json({ ok: true, videoId, title });
});

router.post('/videos/:videoId/toggle', async (req, res) => {
  await db.query(
    'UPDATE videos SET is_active = NOT is_active WHERE video_id = $1',
    [req.params.videoId]
  );
  res.json({ ok: true });
});

// Manual "reply to everything unreplied on this video" — same underlying
// scan logic the scheduler uses, just triggered on demand instead of on a
// timer. This IS the catch-up function.
router.post('/videos/:videoId/catch-up', async (req, res) => {
  const result = await scanVideo(req.params.videoId);
  res.json(result);
});

// Manual "scan everything now" trigger, independent of the schedule.
router.post('/scan-now', async (req, res) => {
  const result = await scanAllActiveVideos();
  res.json(result);
});

// --- Reply log ---
router.get('/replies/recent', async (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const { rows } = await db.query(
    `SELECT thread_id, video_id, original_comment, reply_text, source, replied_at
     FROM replied_threads ORDER BY replied_at DESC LIMIT $1`,
    [limit]
  );
  res.json(rows);
});

module.exports = router;
