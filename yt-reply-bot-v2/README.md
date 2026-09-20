# yt-reply-bot-v2

Second-generation AlvinHub comment-reply bot. Built alongside the existing
`yt-reply-bot` (not replacing it yet) — same YouTube channel, same Google
Cloud project, same 500,000 units/day quota.

## What it does differently from v1

1. **Reply filter**: skips a comment thread if you (the channel owner) have
   *ever* replied in it — no re-replying, no chasing whether the commenter
   responded back. See `backend/src/filter/shouldReply.js`.
2. **Reply voice**: replies are generated with a single editable style prompt
   (`backend/src/replies/stylePrompt.js`) aimed at sounding like you —
   personal, warm, occasionally funny, no corporate filler. No keyword
   special-casing (you decided against that) — it's one consistent voice
   applied to every comment. Drop real (comment → your reply) examples into
   `EXAMPLE_REPLIES` in that file whenever you want to sharpen it further;
   nothing else needs to change.

## Feature parity with v1 (rebuilt here)

- Configurable scan interval (10 / 20 / 30 / 60 min presets or custom)
- Per-video targeting (track/untrack specific videos)
- Manual catch-up ("reply to everything unreplied on this video now")
- Manual "scan all now"
- Auto-pause at a configurable daily unit threshold
- Recent-reply log

## Architecture

```
backend/   Node/Express API + BullMQ workers (Railway)
  src/youtube/    YouTube Data API v3 client + quota tracking
  src/filter/     "have I already replied?" logic
  src/replies/    Claude-generated reply text + the editable style prompt
  src/jobs/       BullMQ queue: scan (read) and reply (write) as separate jobs
  src/scheduler.js  Repeatable scan job, interval read from Postgres settings
  src/routes/api.js Dashboard API
  src/db/schema.sql Postgres schema (videos, replied_threads, quota_usage, settings)

frontend/  React + Vite dashboard (Netlify)
```

Reads (scanning, 1 unit/page) and writes (posting replies, 50 units each) are
two separate BullMQ queues on purpose: a slow/backlogged scan never blocks
replies from going out, and the reply worker is rate-limited independently
(`REPLY_POST_DELAY_MS`) so posts go out spaced apart rather than bursting.

## Setup

```bash
# Backend
cd backend
cp .env.example .env   # fill in the SAME YT_* credentials as v1, plus ANTHROPIC_API_KEY
npm install
npm run start           # runs migration, then starts the server + workers

# Frontend
cd frontend
npm install
npm run dev              # local dev; VITE_API_URL to point at your Railway backend
```

Deploy: backend → Railway (needs a Postgres + Redis addon, same pattern as
v1). Frontend → Netlify, same as the existing dashboard.

## What I couldn't verify from here

- I don't have v1's actual code/UI, only the feature list from your notes —
  this dashboard matches the *functionality* (interval control, per-video
  targeting, auto-pause, catch-up), not necessarily the exact layout. Send
  over the old repo or a screenshot if you want this to visually match it.
- No live test against the YouTube or Anthropic APIs from this environment
  (no network access to googleapis.com from here) — syntax-checked every
  file, but the actual OAuth/posting flow needs testing with your real
  credentials once deployed.
- `google-auth-library`/`googleapis` package versions are recent as of my
  training but worth a quick `npm outdated` check before you deploy, since
  Google ships new majors fairly often.

## Cutover plan (once this is stable)

Run both bots in parallel with v1 pointed at a *different* set of tracked
videos than v2 (or v1 paused) to avoid double-replying to the same threads —
they don't share a database, so nothing here stops both bots from acting on
the same comment if both are live and untracked-video-overlap happens. Once
you're confident in v2, retire v1's workers (Railway service can stay up for
the dashboard/history or be decommissioned).
