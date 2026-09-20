-- Videos we know about / are tracking
CREATE TABLE IF NOT EXISTS videos (
  video_id        TEXT PRIMARY KEY,
  title           TEXT,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_scanned_at TIMESTAMPTZ,
  is_active       BOOLEAN NOT NULL DEFAULT true   -- toggle to pause a video without deleting it
);

-- One row per top-level comment thread we've decided is "handled"
-- (either we replied via the bot, or we detected a pre-existing owner reply).
CREATE TABLE IF NOT EXISTS replied_threads (
  thread_id         TEXT PRIMARY KEY,
  video_id          TEXT NOT NULL REFERENCES videos(video_id),
  parent_comment_id TEXT NOT NULL,
  original_comment  TEXT,
  reply_comment_id  TEXT,          -- null if the reply pre-existed and wasn't posted by us
  reply_text        TEXT,
  source            TEXT NOT NULL DEFAULT 'bot',   -- 'bot' | 'pre_existing'
  replied_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_replied_threads_video ON replied_threads(video_id);

-- Daily YouTube API unit usage, for the auto-pause logic.
-- usage_date is the Pacific-Time day the units were spent (matches YouTube's reset clock).
CREATE TABLE IF NOT EXISTS quota_usage (
  usage_date  DATE PRIMARY KEY,
  units_used  INTEGER NOT NULL DEFAULT 0
);

-- Free-form key/value settings the dashboard can change live (interval, thresholds, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO settings (key, value) VALUES
  ('scan_interval_minutes', '15'),
  ('auto_pause_at_units', '450000'),
  ('bot_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
