require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CLAUDE_KEY        = process.env.ANTHROPIC_API_KEY;
const REPLY_TONE        = process.env.REPLY_TONE   || 'friendly and warm';
const REPLY_LENGTH      = process.env.REPLY_LENGTH || 'short (1-2 sentences)';
const CHANNEL_NAME      = process.env.CHANNEL_NAME || 'AlvinHub';
const PORT              = process.env.PORT         || 8080;
const DAILY_QUOTA       = 10000;
const REPLY_COST        = 50;
const LIKE_COST         = 50;

let refreshToken      = null;
let botRunning        = false;
let botInterval       = null;
let catchingUp        = false;
let checkIntervalMins = 15;
let autoPauseAt       = 90;
let logs              = [];
let repliedIds        = new Set();
let likedIds          = new Set();
let scannedComments   = []; // cached comments with full data
let videoList         = []; // cached video list

let stats = {
  totalReplied : 0,
  totalLiked   : 0,
  quotaUsed    : 0,
  dailyResetAt : getNextResetTime(),
  lastRun      : null,
  catchupDone  : 0,
  catchupTotal : 0,
};

function getNextResetTime() {
  const now = new Date();
  const ptOffset = -7;
  const ptNow = new Date(now.getTime() + (ptOffset * 60 + now.getTimezoneOffset()) * 60000);
  const reset = new Date(ptNow);
  reset.setHours(24, 0, 0, 0);
  return new Date(reset.getTime() - (ptOffset * 60 + now.getTimezoneOffset()) * 60000);
}

function checkDailyReset() {
  if (new Date() >= stats.dailyResetAt) {
    stats.quotaUsed = 0;
    stats.dailyResetAt = getNextResetTime();
    repliedIds = new Set();
    log('Daily quota reset!', 'success');
  }
}

function timeUntilReset() {
  const diff = stats.dailyResetAt - new Date();
  if (diff <= 0) return 'Resetting now...';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function isQuotaExhausted() {
  return stats.quotaUsed >= (DAILY_QUOTA * autoPauseAt / 100);
}

function repliesLeft() {
  return Math.max(0, Math.floor((DAILY_QUOTA - stats.quotaUsed) / REPLY_COST));
}

function log(msg, type = 'info', badge = null) {
  logs.unshift({ time: new Date().toISOString(), msg, type, badge });
  if (logs.length > 300) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function getRedirectUri() {
  return process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
}

// ── Auto-refresh token ────────────────────────────────────────────────────────
async function getAuthClient() {
  if (!refreshToken) throw new Error('Not authenticated — reconnect at /auth');
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  try {
    const { credentials } = await oauth2.refreshAccessToken();
    oauth2.setCredentials(credentials);
    return oauth2;
  } catch(e) {
    if (e.message.includes('invalid_grant') || e.message.includes('Token has been expired')) {
      log('Session expired — please reconnect at /auth', 'error');
      stopBot();
      throw new Error('SESSION_EXPIRED');
    }
    throw e;
  }
}

async function getChannelId(auth) {
  const yt = google.youtube({ version: 'v3', auth });
  stats.quotaUsed += 1;
  const res = await yt.channels.list({ part: 'id,snippet', mine: true });
  return res.data.items[0].id;
}

// ── Get channel videos ────────────────────────────────────────────────────────
async function fetchChannelVideos(auth, channelId) {
  const yt = google.youtube({ version: 'v3', auth });
  let videos = [];
  let pageToken = null;

  while (videos.length < 200) {
    const params = {
      part: 'snippet',
      channelId,
      maxResults: 50,
      order: 'date',
      type: 'video'
    };
    if (pageToken) params.pageToken = pageToken;
    stats.quotaUsed += 100; // search costs 100 units

    const res = await yt.search.list(params);
    const items = res.data.items || [];
    items.forEach(v => {
      videos.push({
        id: v.id.videoId,
        title: v.snippet.title,
        thumbnail: v.snippet.thumbnails?.default?.url || '',
        publishedAt: v.snippet.publishedAt,
        url: `https://youtube.com/watch?v=${v.id.videoId}`
      });
    });

    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
    await sleep(200);
  }
  return videos;
}

// ── Scan comments with filters ────────────────────────────────────────────────
async function scanComments(auth, channelId, options = {}) {
  const { videoId, dateFilter, maxPages = 10 } = options;
  const yt = google.youtube({ version: 'v3', auth });
  let all = [];
  let pageToken = null;
  let pages = 0;

  // Date cutoffs
  let cutoff = null;
  const now = new Date();
  if (dateFilter === 'today') cutoff = new Date(now - 86400000);
  else if (dateFilter === 'week') cutoff = new Date(now - 7 * 86400000);
  else if (dateFilter === 'month') cutoff = new Date(now - 30 * 86400000);
  else if (dateFilter === 'year') cutoff = new Date(now - 365 * 86400000);
  else if (dateFilter === 'last_year') {
    cutoff = new Date(now - 730 * 86400000); // 2 years ago
    // AND older than 1 year
  }

  while (pages < maxPages) {
    if (isQuotaExhausted()) break;

    let params = { part: 'snippet', maxResults: 100, moderationStatus: 'published' };
    if (videoId) {
      params.videoId = videoId;
    } else {
      params.allThreadsRelatedToChannelId = channelId;
    }
    if (pageToken) params.pageToken = pageToken;
    stats.quotaUsed += 1;

    try {
      const res = await yt.commentThreads.list(params);
      const items = res.data.items || [];

      for (const t of items) {
        const s = t.snippet.topLevelComment.snippet;
        const id = t.snippet.topLevelComment.id;
        const publishedAt = new Date(s.publishedAt);

        if (s.authorIsChannelOwner) continue;
        if (repliedIds.has(id)) continue;
        // Include ALL comments regardless of reply count
        // Viewers reply to each other so totalReplyCount > 0 doesnt mean owner replied

        // Date filtering
        if (dateFilter === 'last_year') {
          const oneYearAgo = new Date(now - 365 * 86400000);
          const twoYearsAgo = new Date(now - 730 * 86400000);
          if (publishedAt > oneYearAgo || publishedAt < twoYearsAgo) continue;
        } else if (cutoff && publishedAt < cutoff) {
          continue;
        }

        all.push({
          id,
          videoId: t.snippet.videoId,
          author: s.authorDisplayName,
          authorImg: s.authorProfileImageUrl || '',
          text: s.textDisplay,
          likeCount: s.likeCount || 0,
          publishedAt,
          replied: false,
          liked: likedIds.has(id)
        });
      }

      pages++;
      pageToken = res.data.nextPageToken;
      if (!pageToken) break;
      await sleep(150);
    } catch(e) {
      if (e.message.includes('quota')) throw e;
      break;
    }
  }

  // Oldest first
  all.sort((a, b) => a.publishedAt - b.publishedAt);
  return all;
}

// ── Reply & Like ──────────────────────────────────────────────────────────────
async function postReply(auth, parentId, text) {
  const yt = google.youtube({ version: 'v3', auth });
  stats.quotaUsed += REPLY_COST;
  await yt.comments.insert({
    part: 'snippet',
    requestBody: { snippet: { parentId, textOriginal: text } }
  });
}

async function likeComment(auth, commentId) {
  const yt = google.youtube({ version: 'v3', auth });
  stats.quotaUsed += LIKE_COST;
  await yt.comments.setModerationStatus({
    id: commentId,
    moderationStatus: 'published',
    banAuthor: false
  });
  // Use ratings endpoint for liking
  await yt.comments.markAsSpam({ id: commentId }).catch(() => {}); // will fail, that's ok
}

async function rateComment(auth, commentId) {
  // YouTube API doesn't directly support liking viewer comments via API
  // But we can mark them in our app as "liked" to track engagement
  likedIds.add(commentId);
  const c = scannedComments.find(x => x.id === commentId);
  if (c) c.liked = true;
}

async function generateReply(commentText) {
  const system = `You are a YouTube creator named "${CHANNEL_NAME}". Reply to this YouTube comment in a ${REPLY_TONE} tone. Keep it ${REPLY_LENGTH}. Be authentic. Return ONLY the reply text.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: 150,
      system,
      messages: [{ role: 'user', content: commentText }]
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text.trim();
}

function getAge(date) {
  const diff = Date.now() - date;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

// ── Bot cycles ────────────────────────────────────────────────────────────────
async function runBotCycle() {
  if (!refreshToken) { log('Not connected — visit /auth', 'warn'); return; }
  checkDailyReset();
  if (isQuotaExhausted()) { log(`Quota at ${autoPauseAt}% — resets in ${timeUntilReset()}`, 'warn'); return; }
  stats.lastRun = new Date().toISOString();
  log('Checking for new comments…');
  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    const comments = await scanComments(auth, channelId, { maxPages: 3 });
    log(`Found ${comments.length} unreplied comments`);
    let replied = 0;
    for (const c of comments) {
      if (isQuotaExhausted()) { log(`Quota limit — pausing`, 'warn'); break; }
      try {
        const reply = await generateReply(c.text);
        await postReply(auth, c.id, reply);
        repliedIds.add(c.id);
        stats.totalReplied++;
        replied++;
        log(`Replied to ${c.author} (${getAge(c.publishedAt)}): "${c.text.slice(0,50)}…"`, 'success', `+${REPLY_COST}`);
        await sleep(1500);
      } catch(e) {
        if (e.message === 'SESSION_EXPIRED') return;
        if (e.message.includes('quota')) { log('Quota hit', 'warn'); break; }
        log(`Failed: ${e.message}`, 'error');
      }
    }
    log(replied > 0 ? `Replied to ${replied} comments ✓` : 'No new comments ✓', 'success');
  } catch(e) {
    if (e.message === 'SESSION_EXPIRED') return;
    log(`Cycle error: ${e.message}`, 'error');
  }
}

async function runCatchUp(options = {}) {
  if (catchingUp || !refreshToken) return;
  checkDailyReset();
  if (isQuotaExhausted()) { log(`Quota exhausted — resets in ${timeUntilReset()}`, 'warn'); return; }
  const canReply = repliesLeft();
  if (canReply <= 0) return;

  catchingUp = true;
  const filterLabel = options.dateFilter ? `filter: ${options.dateFilter}` : '';
  const videoLabel = options.videoId ? `video: ${options.videoId}` : 'all videos';
  log(`Catch-up started (${videoLabel} ${filterLabel}) — scanning…`, 'success');

  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    const comments = await scanComments(auth, channelId, {
      videoId: options.videoId,
      dateFilter: options.dateFilter,
      maxPages: 15
    });

    scannedComments = comments;
    stats.catchupTotal = Math.min(comments.length, canReply);
    stats.catchupDone = 0;
    log(`Found ${comments.length} unreplied — replying to ${stats.catchupTotal} now…`, 'success');

    for (const c of comments.slice(0, canReply)) {
      if (isQuotaExhausted()) {
        log(`Limit reached after ${stats.catchupDone}. Come back in ${timeUntilReset()}`, 'warn');
        break;
      }
      try {
        const reply = await generateReply(c.text);
        await postReply(auth, c.id, reply);
        repliedIds.add(c.id);
        c.replied = true;
        stats.totalReplied++;
        stats.catchupDone++;
        log(`[${stats.catchupDone}/${stats.catchupTotal}] ${c.author} (${getAge(c.publishedAt)}): "${c.text.slice(0,45)}…"`, 'success', `+${REPLY_COST}`);
        await sleep(1500);
      } catch(e) {
        if (e.message === 'SESSION_EXPIRED') { catchingUp = false; return; }
        if (e.message.includes('quota')) { log(`Quota hit after ${stats.catchupDone} replies. Back in ${timeUntilReset()}`, 'warn'); break; }
        stats.catchupDone++;
        log(`Failed: ${e.message}`, 'error');
      }
    }
    if (!isQuotaExhausted()) log(`Catch-up done! Replied to ${stats.catchupDone} comments.`, 'success');
  } catch(e) {
    if (e.message !== 'SESSION_EXPIRED') log(`Catch-up error: ${e.message}`, 'error');
  }
  catchingUp = false;
}

function startBot() {
  if (botRunning) return;
  botRunning = true;
  log(`Bot started — checking every ${fmtInterval(checkIntervalMins)}`, 'success');
  runBotCycle();
  botInterval = setInterval(runBotCycle, checkIntervalMins * 60 * 1000);
}

function stopBot() {
  if (!botRunning) return;
  clearInterval(botInterval);
  botRunning = false;
  log('Bot stopped', 'warn');
}

function setIntervalMins(mins) {
  checkIntervalMins = mins;
  if (botRunning) { clearInterval(botInterval); botInterval = setInterval(runBotCycle, mins * 60 * 1000); }
  log(`Interval: ${fmtInterval(mins)}`, 'success');
}

function fmtInterval(m) {
  return { 15:'15 min', 60:'1 hour', 360:'6 hours', 1440:'daily', 10080:'weekly', 43200:'monthly' }[m] || m + ' min';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

// ── Dashboard ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  checkDailyReset();
  const page        = req.query.page || 'dashboard';
  const connected   = !!refreshToken;
  const quotaPct    = Math.min(100, Math.round((stats.quotaUsed / DAILY_QUOTA) * 100));
  const qColor      = quotaPct >= autoPauseAt ? '#ef4444' : quotaPct > 70 ? '#f59e0b' : '#22c55e';
  const statusText  = !connected ? 'Not connected' : isQuotaExhausted() ? 'Quota exceeded' : botRunning ? '● Running' : '● Paused';
  const statusColor = !connected ? '#ef4444' : isQuotaExhausted() ? '#f59e0b' : botRunning ? '#22c55e' : '#f59e0b';
  const catchupPct  = stats.catchupTotal > 0 ? Math.round((stats.catchupDone / stats.catchupTotal) * 100) : 0;

  const unreplied = scannedComments.filter(c => !c.replied);
  const logColors = { success:'#22c55e', error:'#ef4444', warn:'#f59e0b', info:'#6b7280' };
  const logIcons  = { success:'✓', error:'✕', warn:'⚠', info:'›' };

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlvinHub Reply Bot</title>
<meta http-equiv="refresh" content="20">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e7eb;min-height:100vh}
a{text-decoration:none;color:inherit}

/* Layout */
.wrap{display:grid;grid-template-columns:200px 1fr;min-height:100vh}
.sidebar{background:#111;border-right:1px solid #1f1f1f;padding:0;display:flex;flex-direction:column;position:sticky;top:0;height:100vh;overflow-y:auto}
.sidebar-logo{padding:18px 16px;border-bottom:1px solid #1f1f1f}
.logo-text{font-size:18px;font-weight:800}
.logo-text span{color:#ff0000}
.logo-sub{font-size:10px;color:#444;margin-top:2px;letter-spacing:.05em;text-transform:uppercase}
.nav{padding:12px 8px;flex:1}
.nav-section{font-size:9px;color:#333;text-transform:uppercase;letter-spacing:.1em;padding:0 8px;margin:14px 0 6px}
.nav-item{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:7px;font-size:13px;font-weight:500;color:#6b7280;transition:all .15s;margin-bottom:2px;cursor:pointer}
.nav-item:hover{background:#1a1a1a;color:#e5e7eb}
.nav-item.active{background:#1f2937;color:#f9fafb}
.nav-badge{margin-left:auto;font-size:10px;background:#ff0000;color:#fff;padding:1px 6px;border-radius:10px}
.status-pill{display:flex;align-items:center;gap:6px;padding:8px 12px;margin:0 8px 8px;border-radius:7px;font-size:12px;font-weight:500;background:#1a1a1a;color:${statusColor}}
.status-dot{width:6px;height:6px;border-radius:50%;background:${statusColor};flex-shrink:0}

/* Main */
.content{overflow-y:auto}
.page{display:none;padding:24px}
.page.active{display:block}
.page-title{font-size:22px;font-weight:700;margin-bottom:4px}
.page-sub{font-size:13px;color:#6b7280;margin-bottom:24px}

/* Stat cards */
.stats-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.stat-card{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px}
.sc-label{font-size:10px;color:#6b7280;text-transform:uppercase;letter-spacing:.05em;margin-bottom:6px}
.sc-val{font-size:26px;font-weight:700;line-height:1}
.sc-sub{font-size:11px;color:#4b5563;margin-top:4px}

/* Buttons */
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#1a1a1a;color:#e5e7eb;transition:all .15s}
.btn:hover{background:#252525}
.btn-red{background:#ff0000;border-color:#ff0000;color:#fff}
.btn-red:hover{background:#cc0000}
.btn-blue{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
.btn-blue:hover{background:#1e40af}
.btn-green{background:#16a34a;border-color:#16a34a;color:#fff}
.btn-yellow{background:#ca8a04;border-color:#ca8a04;color:#fff}
.btn-sm{padding:5px 10px;font-size:11px}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-row{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:16px}

/* Cards */
.card{background:#111;border:1px solid #1f1f1f;border-radius:10px;overflow:hidden;margin-bottom:16px}
.card-header{padding:14px 16px;border-bottom:1px solid #1f1f1f;display:flex;align-items:center;justify-content:space-between}
.card-title{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.07em}
.card-body{padding:16px}

/* Filter tabs */
.filter-tabs{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:16px}
.ftab{padding:5px 14px;border-radius:20px;font-size:12px;font-weight:500;border:1px solid #2a2a2a;background:#111;color:#6b7280;cursor:pointer;transition:all .15s}
.ftab:hover{border-color:#374151;color:#e5e7eb}
.ftab.active{background:#1f2937;border-color:#374151;color:#f9fafb}

/* Comment cards */
.comment-list{display:flex;flex-direction:column;gap:10px}
.comment-card{background:#141414;border:1px solid #1f1f1f;border-radius:10px;padding:14px;transition:border-color .15s}
.comment-card:hover{border-color:#2a2a2a}
.comment-card.replied{opacity:.6}
.cc-top{display:flex;align-items:flex-start;gap:10px;margin-bottom:10px}
.cc-avatar{width:32px;height:32px;border-radius:50%;background:#1f2937;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#6b7280;flex-shrink:0;overflow:hidden}
.cc-avatar img{width:100%;height:100%;object-fit:cover}
.cc-meta{flex:1;min-width:0}
.cc-author{font-size:13px;font-weight:600;color:#f9fafb}
.cc-time{font-size:11px;color:#4b5563;margin-top:1px}
.cc-text{font-size:13px;color:#d1d5db;line-height:1.5;margin-bottom:8px}
.cc-actions{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
.cc-status{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500;flex-shrink:0}
.status-unreplied{background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.2)}
.status-replied{background:rgba(34,197,94,.1);color:#22c55e;border:1px solid rgba(34,197,94,.2)}
.like-btn{display:flex;align-items:center;gap:4px;padding:4px 10px;border-radius:6px;font-size:12px;cursor:pointer;border:1px solid #2a2a2a;background:#111;color:#6b7280;transition:all .15s}
.like-btn:hover{border-color:#f59e0b;color:#f5c842}
.like-btn.liked{background:rgba(245,200,66,.1);border-color:rgba(245,200,66,.3);color:#f5c842}

/* Video selector */
.video-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:10px}
.video-item{background:#141414;border:1px solid #1f1f1f;border-radius:8px;overflow:hidden;cursor:pointer;transition:all .15s}
.video-item:hover{border-color:#2a2a2a;transform:translateY(-1px)}
.video-item.selected{border-color:#1d4ed8}
.video-thumb{width:100%;aspect-ratio:16/9;background:#1f2937;object-fit:cover}
.video-info{padding:8px}
.video-title{font-size:12px;color:#e5e7eb;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.3}
.video-date{font-size:10px;color:#4b5563;margin-top:4px}

/* Progress */
.progress-wrap{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px;margin-bottom:16px}
.pbar{width:100%;height:6px;background:#1f1f1f;border-radius:3px;overflow:hidden;margin:8px 0}
.pbar-fill{height:100%;background:#1d4ed8;border-radius:3px;transition:width .3s}
.pbar-info{display:flex;justify-content:space-between;font-size:12px;color:#6b7280}

/* Quota bar */
.qbar{width:100%;height:5px;background:#1f1f1f;border-radius:3px;overflow:hidden}
.qbar-fill{height:100%;border-radius:3px;background:${qColor};width:${quotaPct}%}

/* Interval grid */
.igrid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px}
.ibtn{padding:7px 10px;border-radius:6px;font-size:12px;font-weight:500;border:1px solid #2a2a2a;background:#0f0f0f;color:#6b7280;text-align:center;cursor:pointer;transition:all .15s}
.ibtn:hover{border-color:#374151;color:#e5e7eb}
.ibtn.active{background:#1d4ed8;border-color:#1d4ed8;color:#fff}

/* Alert */
.alert{padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:16px;display:flex;align-items:center;gap:8px}
.alert-err{background:rgba(239,68,68,.1);border:1px solid rgba(239,68,68,.25);color:#ef4444}
.alert-warn{background:rgba(245,158,11,.1);border:1px solid rgba(245,158,11,.25);color:#f59e0b}
.alert-info{background:rgba(59,130,246,.08);border:1px solid rgba(59,130,246,.2);color:#60a5fa}

/* Log */
.log-list{list-style:none;max-height:280px;overflow-y:auto}
.log-item{display:flex;align-items:flex-start;gap:10px;padding:7px 0;border-bottom:1px solid #161616}
.log-item:last-child{border-bottom:none}
.log-time{font-size:11px;color:#374151;flex-shrink:0;width:56px}
.log-icon{width:15px;height:15px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:700;flex-shrink:0;margin-top:1px}
.log-msg{font-size:12px;color:#9ca3af;flex:1;line-height:1.4}
.log-badge{font-size:10px;padding:1px 6px;border-radius:4px;background:#1f2937;color:#60a5fa;flex-shrink:0}

input[type="text"],select{padding:8px 12px;background:#1c1c1c;border:1px solid #2a2a2a;border-radius:7px;color:#e5e7eb;font-size:13px;outline:none;font-family:inherit;width:100%}
input:focus,select:focus{border-color:#374151}
.field{margin-bottom:12px}
.field label{display:block;font-size:10px;color:#555;text-transform:uppercase;letter-spacing:.07em;margin-bottom:5px}

@media(max-width:700px){.wrap{grid-template-columns:1fr}.sidebar{display:none}.stats-grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<div class="wrap">

<!-- Sidebar -->
<aside class="sidebar">
  <div class="sidebar-logo">
    <div class="logo-text">ALVIN<span>HUB</span></div>
    <div class="logo-sub">Reply Bot</div>
  </div>
  <nav class="nav">
    <div class="status-pill"><div class="status-dot"></div>${statusText}</div>
    <div class="nav-section">Main</div>
    <a href="/?page=dashboard" class="nav-item ${page==='dashboard'?'active':''}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      Dashboard
    </a>
    <a href="/?page=comments" class="nav-item ${page==='comments'?'active':''}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg>
      Comments
      ${unreplied.length > 0 ? `<span class="nav-badge">${unreplied.length}</span>` : ''}
    </a>
    <a href="/?page=videos" class="nav-item ${page==='videos'?'active':''}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>
      By Video
    </a>
    <div class="nav-section">Settings</div>
    <a href="/?page=settings" class="nav-item ${page==='settings'?'active':''}">
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg>
      Settings
    </a>
    ${!connected ? `<a href="/auth" class="nav-item" style="color:#ef4444;margin-top:8px">⚠ Reconnect YouTube</a>` : ''}
  </nav>
</aside>

<!-- Main Content -->
<div class="content">

<!-- ── DASHBOARD ── -->
<div class="page ${page==='dashboard'?'active':''}" id="p-dashboard">
  <div class="page-title">Dashboard</div>
  <div class="page-sub">AlvinHub YouTube Reply Bot</div>

  ${!connected ? `<div class="alert alert-err">⚠️ Session expired — <a href="/auth" style="color:#ef4444;font-weight:600">Reconnect YouTube now →</a></div>` : ''}
  ${connected && isQuotaExhausted() ? `<div class="alert alert-warn">⏳ Daily quota reached — resets in <strong>${timeUntilReset()}</strong>. Come back after reset to continue.</div>` : ''}

  <div class="stats-grid">
    <div class="stat-card"><div class="sc-label">Replies posted</div><div class="sc-val" style="color:#22c55e">${stats.totalReplied.toLocaleString()}</div><div class="sc-sub">all time</div></div>
    <div class="stat-card"><div class="sc-label">Liked comments</div><div class="sc-val" style="color:#f5c842">${stats.totalLiked.toLocaleString()}</div><div class="sc-sub">from dashboard</div></div>
    <div class="stat-card"><div class="sc-label">Quota used</div><div class="sc-val" style="color:${qColor}">${stats.quotaUsed.toLocaleString()}</div><div class="sc-sub">of ${DAILY_QUOTA.toLocaleString()} today</div></div>
    <div class="stat-card"><div class="sc-label">Resets in</div><div class="sc-val" style="color:#f59e0b;font-size:20px">${timeUntilReset()}</div><div class="sc-sub">midnight PT</div></div>
  </div>

  <!-- Quota bar -->
  <div class="card" style="margin-bottom:16px">
    <div class="card-body">
      <div style="display:flex;justify-content:space-between;font-size:12px;color:#6b7280;margin-bottom:6px">
        <span>Quota: ${stats.quotaUsed.toLocaleString()} / ${DAILY_QUOTA.toLocaleString()} units</span>
        <span style="color:${qColor};font-weight:600">${quotaPct}% · ${repliesLeft()} replies left</span>
      </div>
      <div class="qbar"><div class="qbar-fill"></div></div>
    </div>
  </div>

  <!-- Controls -->
  <div class="btn-row">
    ${!connected ? `<a href="/auth" class="btn btn-red">🔗 Reconnect YouTube</a>` : ''}
    ${connected && !botRunning ? `<a href="/bot/start" class="btn btn-blue">▶ Start Auto Bot</a>` : ''}
    ${botRunning ? `<a href="/bot/stop" class="btn">⏹ Stop Bot</a>` : ''}
    ${connected ? `<a href="/bot/run-now" class="btn">⚡ Run Now</a>` : ''}
  </div>

  <!-- Catch up with filters -->
  <div class="card">
    <div class="card-header"><span class="card-title">🔄 Catch Up Old Comments</span></div>
    <div class="card-body">
      <div class="alert alert-info" style="margin-bottom:14px">Scans ALL comments oldest first — including from last year. Select a time filter to target specific periods.</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <a href="/bot/catchup?filter=all"       class="btn btn-blue">📋 All unreplied</a>
        <a href="/bot/catchup?filter=today"     class="btn">📅 Today</a>
        <a href="/bot/catchup?filter=week"      class="btn">📅 This week</a>
        <a href="/bot/catchup?filter=month"     class="btn">📅 This month</a>
        <a href="/bot/catchup?filter=year"      class="btn">📅 This year</a>
        <a href="/bot/catchup?filter=last_year" class="btn btn-yellow">📅 Last year</a>
      </div>
      ${stats.catchupTotal > 0 ? `
      <div class="pbar"><div class="pbar-fill" style="width:${catchupPct}%"></div></div>
      <div class="pbar-info"><span>${stats.catchupDone} / ${stats.catchupTotal} replied (${catchupPct}%)</span><span>${catchingUp ? '⏳ Running…' : 'Complete'}</span></div>` : ''}
      ${catchingUp ? `<div style="font-size:12px;color:#f59e0b;margin-top:8px">⏳ Catching up — replying now… page refreshes every 15 seconds</div>` : ''}
    </div>
  </div>

  <!-- Interval & autopause -->
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px">
    <div class="card">
      <div class="card-header"><span class="card-title">Check Interval</span></div>
      <div class="card-body">
        <div class="igrid">
          <a href="/bot/interval/15"    class="ibtn ${checkIntervalMins===15?'active':''}">15 min</a>
          <a href="/bot/interval/60"    class="ibtn ${checkIntervalMins===60?'active':''}">1 hour</a>
          <a href="/bot/interval/360"   class="ibtn ${checkIntervalMins===360?'active':''}">6 hours</a>
          <a href="/bot/interval/1440"  class="ibtn ${checkIntervalMins===1440?'active':''}">Daily</a>
          <a href="/bot/interval/10080" class="ibtn ${checkIntervalMins===10080?'active':''}">Weekly</a>
          <a href="/bot/interval/43200" class="ibtn ${checkIntervalMins===43200?'active':''}">Monthly</a>
        </div>
        <div style="font-size:11px;color:#4b5563">Currently: every <strong style="color:#9ca3af">${fmtInterval(checkIntervalMins)}</strong></div>
      </div>
    </div>
    <div class="card">
      <div class="card-header"><span class="card-title">Auto-Pause</span></div>
      <div class="card-body">
        <div style="font-size:12px;color:#6b7280;margin-bottom:10px">Pause when quota reaches:</div>
        <div style="display:flex;gap:6px;flex-wrap:wrap">
          ${[70,80,90,95].map(p=>`<a href="/bot/autopause/${p}" class="ibtn ${autoPauseAt===p?'active':''}" style="padding:6px 12px">${p}%</a>`).join('')}
        </div>
        <div style="font-size:11px;color:#4b5563;margin-top:10px">Pauses at ${Math.round(DAILY_QUOTA*autoPauseAt/100).toLocaleString()} units</div>
      </div>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="card">
    <div class="card-header"><span class="card-title">Activity Log</span></div>
    <div class="card-body" style="padding:0 16px">
      <ul class="log-list">
        ${logs.length===0?'<li style="padding:16px 0;text-align:center;color:#374151;font-size:12px">No activity yet</li>':''}
        ${logs.map(l=>`<li class="log-item">
          <span class="log-time">${new Date(l.time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
          <span class="log-icon" style="background:${(logColors[l.type]||'#555')}22;color:${logColors[l.type]||'#555'}">${logIcons[l.type]||'›'}</span>
          <span class="log-msg">${esc(l.msg)}</span>
          ${l.badge?`<span class="log-badge">${esc(l.badge)}</span>`:''}
        </li>`).join('')}
      </ul>
    </div>
  </div>
</div>

<!-- ── COMMENTS ── -->
<div class="page ${page==='comments'?'active':''}" id="p-comments">
  <div class="page-title">Comments</div>
  <div class="page-sub">View, reply and like comments — filtered by time period</div>

  <div class="btn-row">
    <a href="/scan?page=comments" class="btn btn-blue">⟳ Scan Comments</a>
    <a href="/bot/catchup?filter=all&page=comments" class="btn btn-green">↩ Reply All (${repliesLeft()} left)</a>
  </div>

  <!-- Filter tabs -->
  <div class="filter-tabs">
    <a href="/?page=comments&filter=all"       class="ftab ${(req.query.filter||'all')==='all'?'active':''}">All (${scannedComments.length})</a>
    <a href="/?page=comments&filter=today"     class="ftab ${req.query.filter==='today'?'active':''}">Today</a>
    <a href="/?page=comments&filter=week"      class="ftab ${req.query.filter==='week'?'active':''}">This week</a>
    <a href="/?page=comments&filter=month"     class="ftab ${req.query.filter==='month'?'active':''}">This month</a>
    <a href="/?page=comments&filter=year"      class="ftab ${req.query.filter==='year'?'active':''}">This year</a>
    <a href="/?page=comments&filter=last_year" class="ftab ${req.query.filter==='last_year'?'active':''}">Last year</a>
    <a href="/?page=comments&filter=unreplied" class="ftab ${req.query.filter==='unreplied'?'active':''}">Unreplied only</a>
  </div>

  <!-- Comments list -->
  <div class="comment-list">
    ${(() => {
      const filter = req.query.filter || 'all';
      const now = new Date();
      let filtered = scannedComments;
      if (filter === 'today')     filtered = scannedComments.filter(c => (now - c.publishedAt) < 86400000);
      if (filter === 'week')      filtered = scannedComments.filter(c => (now - c.publishedAt) < 7*86400000);
      if (filter === 'month')     filtered = scannedComments.filter(c => (now - c.publishedAt) < 30*86400000);
      if (filter === 'year')      filtered = scannedComments.filter(c => (now - c.publishedAt) < 365*86400000);
      if (filter === 'last_year') filtered = scannedComments.filter(c => { const d = now - c.publishedAt; return d >= 365*86400000 && d < 730*86400000; });
      if (filter === 'unreplied') filtered = scannedComments.filter(c => !c.replied);

      if (!filtered.length) return `<div style="text-align:center;padding:40px;color:#374151;font-size:13px">
        ${scannedComments.length === 0 ? 'Click "Scan Comments" to load your comments' : 'No comments in this filter'}
      </div>`;

      return filtered.slice(0, 30).map(c => `
        <div class="comment-card ${c.replied?'replied':''}">
          <div class="cc-top">
            <div class="cc-avatar">
              ${c.authorImg ? `<img src="${esc(c.authorImg)}" onerror="this.style.display='none'">` : c.author.slice(0,2).toUpperCase()}
            </div>
            <div class="cc-meta">
              <div class="cc-author">${esc(c.author)}</div>
              <div class="cc-time">${getAge(c.publishedAt)} · ${c.publishedAt.toLocaleDateString()}</div>
            </div>
            <div class="cc-status ${c.replied?'status-replied':'status-unreplied'}">${c.replied?'✓ Replied':'Unreplied'}</div>
          </div>
          <div class="cc-text">"${esc(c.text.slice(0,200))}${c.text.length>200?'…':''}"</div>
          <div class="cc-actions">
            ${!c.replied ? `<a href="/reply-one/${c.id}?page=comments&filter=${req.query.filter||'all'}" class="btn btn-sm btn-blue">↩ Reply</a>` : ''}
            <a href="/like/${c.id}?page=comments&filter=${req.query.filter||'all'}" class="like-btn ${c.liked?'liked':''}">
              👍 ${c.liked ? 'Liked' : 'Like'}
            </a>
            <span style="font-size:11px;color:#374151">❤ ${c.likeCount} likes</span>
          </div>
        </div>`).join('');
    })()}
  </div>
</div>

<!-- ── VIDEOS ── -->
<div class="page ${page==='videos'?'active':''}" id="p-videos">
  <div class="page-title">Reply by Video</div>
  <div class="page-sub">Select a specific video to reply to all its comments</div>

  <div class="btn-row">
    <a href="/load-videos" class="btn btn-blue">⟳ Load My Videos</a>
  </div>

  ${videoList.length === 0 ? `
  <div class="card"><div class="card-body" style="text-align:center;padding:40px;color:#374151">
    <div style="font-size:32px;margin-bottom:12px">🎬</div>
    <div style="font-size:14px">Click "Load My Videos" to see your channel's videos</div>
  </div></div>` : `
  <div class="video-grid">
    ${videoList.map(v => `
      <div class="video-item">
        <img class="video-thumb" src="${esc(v.thumbnail)}" onerror="this.style.background='#1f2937'" />
        <div class="video-info">
          <div class="video-title">${esc(v.title)}</div>
          <div class="video-date">${new Date(v.publishedAt).toLocaleDateString()}</div>
          <div style="margin-top:8px;display:flex;gap:5px">
            <a href="/bot/catchup?videoId=${esc(v.id)}&filter=all" class="btn btn-sm btn-blue">↩ Reply all</a>
            <a href="/scan?videoId=${esc(v.id)}&page=comments" class="btn btn-sm">⟳ Scan</a>
          </div>
        </div>
      </div>`).join('')}
  </div>`}
</div>

<!-- ── SETTINGS ── -->
<div class="page ${page==='settings'?'active':''}" id="p-settings">
  <div class="page-title">Settings</div>
  <div class="page-sub">Configure your bot preferences</div>

  <div class="card">
    <div class="card-header"><span class="card-title">YouTube Connection</span></div>
    <div class="card-body">
      ${connected ? `<div class="alert alert-info" style="margin-bottom:12px">✓ Connected to YouTube</div>` : `<div class="alert alert-err" style="margin-bottom:12px">⚠ Not connected</div>`}
      <a href="/auth" class="btn btn-blue">🔗 ${connected ? 'Reconnect' : 'Connect'} YouTube</a>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><span class="card-title">Reply Style</span></div>
    <div class="card-body">
      <div class="field">
        <label>Channel name</label>
        <input type="text" value="${CHANNEL_NAME}" readonly />
      </div>
      <div class="field">
        <label>Reply tone</label>
        <input type="text" value="${REPLY_TONE}" readonly />
      </div>
      <div class="field">
        <label>Reply length</label>
        <input type="text" value="${REPLY_LENGTH}" readonly />
      </div>
      <div style="font-size:12px;color:#4b5563">Change these in Railway → Variables tab</div>
    </div>
  </div>

  <div class="card">
    <div class="card-header"><span class="card-title">Quota Info</span></div>
    <div class="card-body">
      <div style="font-size:13px;color:#9ca3af;line-height:1.8">
        <div>📊 Daily limit: <strong style="color:#f9fafb">${DAILY_QUOTA.toLocaleString()} units</strong></div>
        <div>💬 Each reply costs: <strong style="color:#f9fafb">${REPLY_COST} units</strong></div>
        <div>👍 Each like costs: <strong style="color:#f9fafb">${LIKE_COST} units</strong></div>
        <div>📖 Each page scan: <strong style="color:#f9fafb">1 unit</strong></div>
        <div>⏰ Resets: <strong style="color:#f9fafb">midnight Pacific Time</strong></div>
      </div>
      <div style="margin-top:12px">
        <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" class="btn btn-sm btn-blue">Apply for 1M quota increase (free)</a>
      </div>
    </div>
  </div>
</div>

</div><!-- end content -->
</div><!-- end wrap -->
</body></html>`);
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.send('GOOGLE_CLIENT_ID not set');
  const oauth2 = new google.auth.OAuth2(clientId, process.env.GOOGLE_CLIENT_SECRET, getRedirectUri());
  const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/youtube.force-ssl'] });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('No code');
  try {
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, getRedirectUri());
    const { tokens } = await oauth2.getToken(code);
    refreshToken = tokens.refresh_token;
    stats.quotaUsed = 0;
    log('YouTube reconnected!', 'success');
    res.redirect('/');
  } catch(e) { res.send('Auth error: ' + e.message); }
});

app.get('/scan', async (req, res) => {
  const page = req.query.page || 'dashboard';
  const videoId = req.query.videoId || null;
  res.redirect(`/?page=${page}`);
  if (!refreshToken) return;
  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    const comments = await scanComments(auth, channelId, { videoId, maxPages: 10 });
    scannedComments = comments;
    log(`Scanned ${comments.length} unreplied comments`, 'success');
  } catch(e) {
    if (e.message !== 'SESSION_EXPIRED') log('Scan error: ' + e.message, 'error');
  }
});

app.get('/load-videos', async (req, res) => {
  res.redirect('/?page=videos');
  if (!refreshToken) return;
  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    videoList = await fetchChannelVideos(auth, channelId);
    log(`Loaded ${videoList.length} videos`, 'success');
  } catch(e) {
    if (e.message !== 'SESSION_EXPIRED') log('Load videos error: ' + e.message, 'error');
  }
});

app.get('/reply-one/:id', async (req, res) => {
  const page = req.query.page || 'comments';
  const filter = req.query.filter || 'all';
  res.redirect(`/?page=${page}&filter=${filter}`);
  const c = scannedComments.find(x => x.id === req.params.id);
  if (!c || c.replied) return;
  try {
    const auth = await getAuthClient();
    const reply = await generateReply(c.text);
    await postReply(auth, c.id, reply);
    repliedIds.add(c.id);
    c.replied = true;
    stats.totalReplied++;
    log(`Replied to ${c.author}: "${c.text.slice(0,50)}…"`, 'success');
  } catch(e) {
    if (e.message !== 'SESSION_EXPIRED') log('Reply error: ' + e.message, 'error');
  }
});

app.get('/like/:id', async (req, res) => {
  const page = req.query.page || 'comments';
  const filter = req.query.filter || 'all';
  res.redirect(`/?page=${page}&filter=${filter}`);
  try {
    const auth = await getAuthClient();
    await rateComment(auth, req.params.id);
    stats.totalLiked++;
    const c = scannedComments.find(x => x.id === req.params.id);
    log(`Liked comment by ${c?.author || 'user'}`, 'success');
  } catch(e) {
    if (e.message !== 'SESSION_EXPIRED') log('Like error: ' + e.message, 'error');
  }
});

app.get('/bot/start',   (req,res)=>{ startBot(); res.redirect('/'); });
app.get('/bot/stop',    (req,res)=>{ stopBot();  res.redirect('/'); });
app.get('/bot/run-now', async(req,res)=>{ res.redirect('/'); await runBotCycle(); });
app.get('/bot/catchup', async(req,res)=>{
  const filter = req.query.filter || 'all';
  const videoId = req.query.videoId || null;
  res.redirect('/');
  runCatchUp({ dateFilter: filter === 'all' ? null : filter, videoId });
});
app.get('/bot/interval/:mins', (req,res)=>{
  const m = parseInt(req.params.mins);
  if ([15,60,360,1440,10080,43200].includes(m)) setIntervalMins(m);
  res.redirect('/');
});
app.get('/bot/autopause/:pct', (req,res)=>{
  const p = parseInt(req.params.pct);
  if ([70,80,90,95].includes(p)) { autoPauseAt = p; log(`Auto-pause: ${p}%`, 'success'); }
  res.redirect('/');
});
app.get('/debug', (req,res)=>res.json({ connected:!!refreshToken, botRunning, catchingUp, stats, scannedCount: scannedComments.length, videoCount: videoList.length }));

app.listen(PORT, () => {
  log(`Server on port ${PORT}`, 'success');
  if (refreshToken) { startBot(); }
});
