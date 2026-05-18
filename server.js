require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CLAUDE_KEY          = process.env.ANTHROPIC_API_KEY;
const REPLY_TONE          = process.env.REPLY_TONE    || 'friendly and warm';
const REPLY_LENGTH        = process.env.REPLY_LENGTH  || 'short (1-2 sentences)';
const CHANNEL_NAME        = process.env.CHANNEL_NAME  || 'AlvinHub';
const PORT                = process.env.PORT          || 8080;
const DAILY_QUOTA_UNITS   = 10000;
const REPLY_COST_UNITS    = 50;
const READ_COST_UNITS     = 1;
const MAX_REPLIES_PER_DAY = Math.floor(DAILY_QUOTA_UNITS / REPLY_COST_UNITS); // ~186

let refreshToken      = process.env.GOOGLE_REFRESH_TOKEN || null;
let botRunning        = false;
let botInterval       = null;
let catchingUp        = false;
let checkIntervalMins = 15;
let autoPauseAt       = 90; // percent
let logs              = [];
let repliedIds        = new Set();
let scannedComments   = []; // cached comment list

let stats = {
  totalReplied  : 0,
  unrepliedCount: null,
  quotaUsed     : 0,
  dailyResetAt  : getNextResetTime(),
  lastRun       : null,
  catchupDone   : 0,
  catchupTotal  : 0,
};

function getNextResetTime() {
  const now = new Date();
  // Midnight Pacific Time (UTC-7 PDT / UTC-8 PST)
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
    log('Daily quota reset! Ready to reply again.', 'success');
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
  return stats.quotaUsed >= (DAILY_QUOTA_UNITS * autoPauseAt / 100);
}

function repliesRemainingToday() {
  const remaining = DAILY_QUOTA_UNITS - stats.quotaUsed;
  return Math.max(0, Math.floor(remaining / REPLY_COST_UNITS));
}

function log(msg, type = 'info', badge = null) {
  logs.unshift({ time: new Date().toISOString(), msg, type, badge });
  if (logs.length > 300) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function getRedirectUri() {
  return process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
}

async function getAuthClient() {
  if (!refreshToken) throw new Error('Not authenticated');
  const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, getRedirectUri());
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();
  oauth2.setCredentials(credentials);
  return oauth2;
}

async function getChannelId(auth) {
  const yt = google.youtube({ version: 'v3', auth });
  stats.quotaUsed += READ_COST_UNITS;
  const res = await yt.channels.list({ part: 'id', mine: true });
  return res.data.items[0].id;
}

async function scanComments(auth, channelId, maxPages = 5) {
  const yt = google.youtube({ version: 'v3', auth });
  let all = [];
  let pageToken = null;
  let pages = 0;
  while (pages < maxPages) {
    const params = { part: 'snippet', allThreadsRelatedToChannelId: channelId, maxResults: 100, order: 'time', moderationStatus: 'published' };
    if (pageToken) params.pageToken = pageToken;
    stats.quotaUsed += READ_COST_UNITS;
    const res = await yt.commentThreads.list(params);
    const items = res.data.items || [];
    items.forEach(t => {
      const s = t.snippet.topLevelComment.snippet;
      const id = t.snippet.topLevelComment.id;
      const hasReply = t.snippet.totalReplyCount > 0 || repliedIds.has(id);
      all.push({
        id,
        threadId: t.id,
        author: s.authorDisplayName,
        avatar: (s.authorDisplayName || 'U').slice(0,2).toUpperCase(),
        text: s.textDisplay,
        videoTitle: t.snippet.videoId,
        publishedAt: new Date(s.publishedAt),
        isOwn: s.authorIsChannelOwner,
        replied: hasReply,
        skipped: false
      });
    });
    pages++;
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
    await sleep(300);
  }
  return all;
}

async function postReply(auth, parentId, text) {
  const yt = google.youtube({ version: 'v3', auth });
  stats.quotaUsed += REPLY_COST_UNITS;
  await yt.comments.insert({ part: 'snippet', requestBody: { snippet: { parentId, textOriginal: text } } });
}

async function generateReply(commentText) {
  const system = `You are a YouTube creator named "${CHANNEL_NAME}". Reply to this YouTube comment in a ${REPLY_TONE} tone. Keep it ${REPLY_LENGTH}. Be authentic — no hollow phrases. Return ONLY the reply text.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 150, system, messages: [{ role: 'user', content: commentText }] })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text.trim();
}

async function runBotCycle() {
  if (!refreshToken) { log('YouTube not connected — visit /auth', 'error'); return; }
  checkDailyReset();
  if (isQuotaExhausted()) { log(`Quota at ${autoPauseAt}% — pausing until ${timeUntilReset()}`, 'warn', `${stats.quotaUsed}/${DAILY_QUOTA_UNITS}`); return; }
  stats.lastRun = new Date().toISOString();
  log('Checking for new comments…');
  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    const comments = await scanComments(auth, channelId, 2);
    scannedComments = comments;
    const unreplied = comments.filter(c => !c.replied && !c.isOwn);
    stats.unrepliedCount = unreplied.length;
    log(`Found ${unreplied.length} unreplied comments`);
    let replied = 0;
    for (const c of unreplied) {
      if (isQuotaExhausted()) { log(`Quota at ${autoPauseAt}% — pausing. Resets in ${timeUntilReset()}`, 'warn', `${stats.quotaUsed}/${DAILY_QUOTA_UNITS}`); break; }
      try {
        const reply = await generateReply(c.text);
        await postReply(auth, c.id, reply);
        repliedIds.add(c.id);
        c.replied = true;
        stats.totalReplied++;
        replied++;
        log(`Replied to ${c.author}: "${c.text.slice(0,50)}…"`, 'success', `+${REPLY_COST_UNITS} units`);
        await sleep(2000);
      } catch(e) {
        if (e.message.includes('quota')) { log(`Quota exceeded — resets in ${timeUntilReset()}`, 'warn'); break; }
        log(`Failed: ${e.message}`, 'error');
      }
    }
    if (replied > 0) log(`Cycle complete — replied to ${replied} comments ✓`, 'success', `+${replied * REPLY_COST_UNITS} units`);
    else log('Cycle complete ✓', 'success');
  } catch(e) {
    if (e.message.includes('invalid_grant')) { log('YouTube session expired — reconnect at /auth', 'error'); stopBot(); }
    else log(`Cycle error: ${e.message}`, 'error');
  }
}

async function runCatchUp() {
  if (catchingUp || !refreshToken) return;
  checkDailyReset();
  if (isQuotaExhausted()) { log(`Quota exhausted — come back in ${timeUntilReset()}`, 'warn'); return; }
  catchingUp = true;
  const canReply = repliesRemainingToday();
  log(`Catch-up started — replying to up to ${canReply} comments`, 'success');
  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    const comments = await scanComments(auth, channelId, 5);
    scannedComments = comments;
    const unreplied = comments.filter(c => !c.replied && !c.isOwn);
    stats.unrepliedCount = unreplied.length;
    stats.catchupTotal = Math.min(unreplied.length, canReply);
    stats.catchupDone  = 0;
    log(`Found ${unreplied.length} unreplied — will reply to ${stats.catchupTotal}`, 'success');
    for (const c of unreplied.slice(0, canReply)) {
      if (isQuotaExhausted()) {
        log(`Daily limit reached after ${stats.catchupDone} replies. Come back in ${timeUntilReset()}`, 'warn', `${stats.quotaUsed}/${DAILY_QUOTA_UNITS}`);
        break;
      }
      try {
        const reply = await generateReply(c.text);
        await postReply(auth, c.id, reply);
        repliedIds.add(c.id);
        c.replied = true;
        stats.totalReplied++;
        stats.catchupDone++;
        log(`[${stats.catchupDone}/${stats.catchupTotal}] Replied to ${c.author}: "${c.text.slice(0,45)}…"`, 'success', `+${REPLY_COST_UNITS} units`);
        await sleep(2000);
      } catch(e) {
        if (e.message.includes('quota')) { log(`Quota hit — resets in ${timeUntilReset()}`, 'warn'); break; }
        stats.catchupDone++;
        log(`Failed: ${e.message}`, 'error');
      }
    }
    try { stats.unrepliedCount = scannedComments.filter(c => !c.replied && !c.isOwn).length; } catch(e) {}
    if (!isQuotaExhausted()) log(`Catch-up complete! Replied to ${stats.catchupDone} comments.`, 'success');
  } catch(e) {
    if (e.message.includes('invalid_grant')) log('Session expired — reconnect at /auth', 'error');
    else log(`Catch-up error: ${e.message}`, 'error');
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
  log('Bot stopped manually', 'warn');
}

function setInterval2(mins) {
  checkIntervalMins = mins;
  if (botRunning) { clearInterval(botInterval); botInterval = setInterval(runBotCycle, mins * 60 * 1000); }
  log(`Check interval set to ${fmtInterval(mins)}`, 'success');
}

function fmtInterval(mins) {
  if (mins === 15) return '15 minutes';
  if (mins === 60) return '1 hour';
  if (mins === 360) return '6 hours';
  if (mins === 1440) return 'daily';
  if (mins === 10080) return 'weekly';
  if (mins === 43200) return 'monthly';
  return mins + ' minutes';
}

function fmtTime(iso) {
  const d = new Date(iso);
  const now = new Date();
  const diff = now - d;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return Math.floor(diff/60000) + ' minutes ago';
  if (diff < 86400000) return Math.floor(diff/3600000) + ' hours ago';
  if (diff < 604800000) return Math.floor(diff/86400000) + ' days ago';
  return d.toLocaleDateString();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const filter = req.query.filter || 'all';
  checkDailyReset();
  const connected    = !!refreshToken;
  const quotaPct     = Math.min(100, Math.round((stats.quotaUsed / DAILY_QUOTA_UNITS) * 100));
  const quotaColor   = quotaPct >= autoPauseAt ? '#ef4444' : quotaPct > 70 ? '#f59e0b' : '#22c55e';
  const statusText   = !connected ? 'Not connected' : isQuotaExhausted() ? 'Paused — quota exceeded' : botRunning ? 'Running' : 'Paused';
  const statusDot    = !connected ? '#ef4444' : isQuotaExhausted() ? '#f59e0b' : botRunning ? '#22c55e' : '#f59e0b';
  const remaining    = repliesRemainingToday();

  // Filter comments
  const now = new Date();
  const unreplied = scannedComments.filter(c => !c.replied && !c.isOwn);
  const todayComments   = unreplied.filter(c => (now - c.publishedAt) < 86400000);
  const weekComments    = unreplied.filter(c => (now - c.publishedAt) < 604800000);
  const monthComments   = unreplied.filter(c => (now - c.publishedAt) < 2592000000);
  const olderComments   = unreplied.filter(c => (now - c.publishedAt) >= 2592000000);

  let displayComments = unreplied;
  if (filter === 'today') displayComments = todayComments;
  else if (filter === 'week') displayComments = weekComments;
  else if (filter === 'month') displayComments = monthComments;
  else if (filter === 'older') displayComments = olderComments;

  const logIcons = { success: '✓', error: '✕', warn: '⚠', info: '›' };
  const logColors = { success: '#22c55e', error: '#ef4444', warn: '#f59e0b', info: '#6b7280' };

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlvinHub AI Reply Bot</title>
<meta http-equiv="refresh" content="20">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e7eb;min-height:100vh;font-size:14px}
a{text-decoration:none;color:inherit}

/* Header */
.header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:#111;border-bottom:1px solid #1f1f1f;position:sticky;top:0;z-index:100}
.header-left{display:flex;align-items:center;gap:10px}
.yt-icon{width:32px;height:22px;background:#ff0000;border-radius:6px;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.yt-icon svg{width:14px;height:14px;fill:white}
.header-title{font-size:15px;font-weight:600}
.header-status{display:flex;align-items:center;gap:6px;font-size:12px;color:#9ca3af;margin-top:2px}
.status-dot{width:7px;height:7px;border-radius:50%;background:${statusDot};flex-shrink:0}
.header-btns{display:flex;gap:8px}
.hbtn{display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#1a1a1a;color:#e5e7eb;transition:all .15s}
.hbtn:hover{background:#252525;border-color:#3a3a3a}
.hbtn-primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
.hbtn-primary:hover{background:#1e40af;border-color:#1e40af}

main{max-width:900px;margin:0 auto;padding:24px 20px}

/* Top stats */
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.stat-box{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px 18px}
.stat-label{font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.stat-value{font-size:28px;font-weight:700;line-height:1;color:#f9fafb}
.stat-sub{font-size:11px;color:#6b7280;margin-top:4px}
.stat-value.red{color:#ef4444}
.stat-value.green{color:#22c55e}
.stat-value.amber{color:#f59e0b}

/* Two column */
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.panel{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:18px}
.panel-title{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}

/* Quota */
.quota-bar-wrap{margin-bottom:12px}
.quota-bar-label{display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px}
.quota-bar-label span:first-child{color:#9ca3af}
.quota-bar-label span:last-child{color:${quotaColor};font-weight:600}
.quota-bar{width:100%;height:6px;background:#1f1f1f;border-radius:3px;overflow:hidden}
.quota-bar-fill{height:100%;border-radius:3px;background:${quotaColor};width:${quotaPct}%}
.quota-stats{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px}
.qs{background:#0f0f0f;border-radius:6px;padding:10px;text-align:center}
.qs-val{font-size:13px;font-weight:600;color:#f9fafb}
.qs-lbl{font-size:10px;color:#6b7280;margin-top:2px}
.qs-sub{font-size:10px;color:#4b5563;margin-top:1px}
.quota-tip{background:#0f172a;border:1px solid #1e3a5f;border-radius:8px;padding:12px;font-size:12px;color:#60a5fa;display:flex;gap:8px;align-items:flex-start;cursor:pointer}
.quota-tip a{color:#60a5fa}

/* Interval */
.interval-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px}
.ibtn{padding:8px 12px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#0f0f0f;color:#9ca3af;text-align:center;transition:all .15s}
.ibtn:hover{border-color:#374151;color:#e5e7eb}
.ibtn.active{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
.interval-hint{font-size:11px;color:#6b7280;line-height:1.5;margin-bottom:14px;background:#0f0f0f;border-radius:6px;padding:10px}
.interval-hint strong{color:#e5e7eb}

/* Auto-pause */
.ap-title{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:10px}
.ap-row{display:flex;align-items:center;justify-content:space-between}
.ap-label{font-size:12px;color:#9ca3af}
.ap-val{font-size:13px;font-weight:600;color:#f9fafb}
.ap-sub{font-size:11px;color:#6b7280;margin-top:4px}

/* Scanner */
.scanner{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:18px;margin-bottom:20px}
.scanner-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.scanner-title{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.06em}
.scanner-btns{display:flex;gap:8px}
.sbtn{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#1a1a1a;color:#e5e7eb;transition:all .15s}
.sbtn:hover{background:#252525}
.sbtn-primary{background:#1d4ed8;border-color:#1d4ed8}

/* Filter tabs */
.filter-tabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.ftab{padding:5px 12px;border-radius:20px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#0f0f0f;color:#9ca3af;transition:all .15s}
.ftab:hover{border-color:#374151;color:#e5e7eb}
.ftab.active{background:#1f2937;border-color:#374151;color:#f9fafb}

/* Comment cards */
.comment-card{display:flex;align-items:flex-start;gap:12px;padding:14px 0;border-bottom:1px solid #1a1a1a}
.comment-card:last-child{border-bottom:none}
.avatar{width:36px;height:36px;border-radius:50%;background:#1f2937;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;color:#9ca3af;flex-shrink:0}
.comment-body{flex:1;min-width:0}
.comment-meta{display:flex;align-items:center;gap:6px;margin-bottom:3px;flex-wrap:wrap}
.comment-author{font-size:13px;font-weight:600;color:#f9fafb}
.comment-on{font-size:12px;color:#6b7280}
.comment-text{font-size:13px;color:#d1d5db;margin-bottom:4px;line-height:1.4}
.comment-time{font-size:11px;color:#6b7280}
.comment-actions{display:flex;flex-direction:column;align-items:flex-end;gap:6px;flex-shrink:0}
.pill{display:inline-flex;align-items:center;gap:4px;padding:3px 8px;border-radius:20px;font-size:11px;font-weight:500}
.pill-unreplied{background:#422006;color:#fb923c;border:1px solid #7c2d12}
.pill-replied{background:#052e16;color:#4ade80;border:1px solid #14532d}
.pill-skipped{background:#1a1a1a;color:#6b7280;border:1px solid #2a2a2a}
.reply-btn{display:flex;align-items:center;gap:5px;padding:5px 10px;border-radius:6px;font-size:11px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#1a1a1a;color:#e5e7eb;transition:all .15s}
.reply-btn:hover{background:#252525}
.scanner-footer{text-align:center;font-size:12px;color:#6b7280;padding-top:12px;margin-top:4px;border-top:1px solid #1a1a1a}

/* Catch-up progress */
.catchup-bar-wrap{margin-bottom:14px;background:#0f0f0f;border-radius:8px;padding:12px}
.catchup-bar{width:100%;height:6px;background:#1f1f1f;border-radius:3px;overflow:hidden;margin:8px 0}
.catchup-bar-fill{height:100%;background:#1d4ed8;border-radius:3px}
.catchup-info{display:flex;justify-content:space-between;font-size:12px;color:#6b7280}

/* Activity log */
.log-panel{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:18px}
.log-list{list-style:none;max-height:300px;overflow-y:auto}
.log-item{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid #161616}
.log-item:last-child{border-bottom:none}
.log-time{font-size:11px;color:#4b5563;flex-shrink:0;width:58px;font-variant-numeric:tabular-nums}
.log-icon{width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;margin-top:1px}
.log-msg{font-size:12px;color:#9ca3af;flex:1;line-height:1.4}
.log-badge{font-size:10px;padding:2px 7px;border-radius:4px;background:#1f2937;color:#60a5fa;border:1px solid #1e3a5f;flex-shrink:0;margin-top:1px}

@media(max-width:640px){
  .stats-row{grid-template-columns:1fr 1fr}
  .two-col{grid-template-columns:1fr}
  .interval-grid{grid-template-columns:1fr 1fr 1fr}
  header .header-title{font-size:13px}
}
</style>
</head>
<body>

<!-- Header -->
<div class="header">
  <div class="header-left">
    <div class="yt-icon"><svg viewBox="0 0 24 24"><path d="M19.6 3H4.4A4.4 4.4 0 000 7.4v9.2A4.4 4.4 0 004.4 21h15.2a4.4 4.4 0 004.4-4.4V7.4A4.4 4.4 0 0019.6 3zM9.5 15.5v-7l7 3.5-7 3.5z"/></svg></div>
    <div>
      <div class="header-title">AlvinHub AI Reply Bot</div>
      <div class="header-status"><div class="status-dot"></div>${statusText}</div>
    </div>
  </div>
  <div class="header-btns">
    ${!connected ? `<a href="/auth" class="hbtn hbtn-primary">Connect YouTube</a>` : ''}
    ${connected ? `<a href="/bot/run-now" class="hbtn">▶ Run now</a>` : ''}
    ${connected && !botRunning ? `<a href="/bot/start" class="hbtn hbtn-primary">▶ Start bot</a>` : ''}
    ${botRunning ? `<a href="/bot/stop" class="hbtn">⏹ Stop bot</a>` : ''}
  </div>
</div>

<main>

  <!-- Stats Row -->
  <div class="stats-row">
    <div class="stat-box">
      <div class="stat-label">Replies posted</div>
      <div class="stat-value green">${stats.totalReplied.toLocaleString()}</div>
      <div class="stat-sub">all time</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Unreplied</div>
      <div class="stat-value ${(stats.unrepliedCount||0) > 0 ? 'red' : 'green'}">${stats.unrepliedCount !== null ? stats.unrepliedCount : '—'}</div>
      <div class="stat-sub">pending replies</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Quota used today</div>
      <div class="stat-value ${quotaPct >= autoPauseAt ? 'red' : 'amber'}">${stats.quotaUsed.toLocaleString()}</div>
      <div class="stat-sub">of ${DAILY_QUOTA_UNITS.toLocaleString()} units</div>
    </div>
    <div class="stat-box">
      <div class="stat-label">Quota resets in</div>
      <div class="stat-value amber" style="font-size:22px">${timeUntilReset()}</div>
      <div class="stat-sub">midnight PT</div>
    </div>
  </div>

  <!-- Two Column -->
  <div class="two-col">

    <!-- Quota Panel -->
    <div class="panel">
      <div class="panel-title">Quota Usage</div>
      <div class="quota-bar-wrap">
        <div class="quota-bar-label"><span>${stats.quotaUsed.toLocaleString()} / ${DAILY_QUOTA_UNITS.toLocaleString()} units</span><span>${quotaPct}%</span></div>
        <div class="quota-bar"><div class="quota-bar-fill"></div></div>
      </div>
      <div class="quota-stats">
        <div class="qs"><div class="qs-val">~50 units</div><div class="qs-lbl">Reading comments</div><div class="qs-sub">1 unit per page fetch</div></div>
        <div class="qs"><div class="qs-val">${REPLY_COST_UNITS} units</div><div class="qs-lbl">Each reply</div><div class="qs-sub">max ~${MAX_REPLIES_PER_DAY} replies/day</div></div>
        <div class="qs"><div class="qs-val" style="color:${remaining > 10 ? '#22c55e' : '#ef4444'}">${remaining} replies</div><div class="qs-lbl">Remaining today</div><div class="qs-sub">until reset</div></div>
      </div>
      <div class="quota-tip">
        <span>✦</span>
        <span><a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank">Apply for a quota increase in Google Cloud Console → APIs → YouTube Data API v3 → Quotas.</a> Free increases up to 1M units/day are available.</span>
      </div>
    </div>

    <!-- Interval Panel -->
    <div class="panel">
      <div class="panel-title">Check Interval</div>
      <div class="interval-grid">
        <a href="/bot/interval/15"    class="ibtn ${checkIntervalMins===15?'active':''}">Every 15 min</a>
        <a href="/bot/interval/60"    class="ibtn ${checkIntervalMins===60?'active':''}">Every hour</a>
        <a href="/bot/interval/360"   class="ibtn ${checkIntervalMins===360?'active':''}">Every 6 hours</a>
        <a href="/bot/interval/1440"  class="ibtn ${checkIntervalMins===1440?'active':''}">Daily</a>
        <a href="/bot/interval/10080" class="ibtn ${checkIntervalMins===10080?'active':''}">Weekly</a>
        <a href="/bot/interval/43200" class="ibtn ${checkIntervalMins===43200?'active':''}">Monthly</a>
      </div>
      <div class="interval-hint">
        ⓘ Checking every <strong>${fmtInterval(checkIntervalMins)}</strong>. With current quota, this triggers ~${Math.round(1440/checkIntervalMins)} checks/day — each check costs 1 unit. Consider switching to <strong>hourly</strong> when quota is low.
      </div>
      <div class="ap-title">Quota Auto-Pause</div>
      <div class="ap-row">
        <div class="ap-label">Pause when quota reaches</div>
        <div class="ap-val">${autoPauseAt}%</div>
      </div>
      <div class="ap-sub">Pauses at ${Math.round(DAILY_QUOTA_UNITS * autoPauseAt / 100).toLocaleString()} units — reserves quota for next cycle</div>
      <div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">
        ${[70,80,90,95].map(p => `<a href="/bot/autopause/${p}" class="ibtn ${autoPauseAt===p?'active':''}" style="padding:5px 10px;font-size:11px">${p}%</a>`).join('')}
      </div>
    </div>
  </div>

  <!-- Catch-up progress -->
  ${stats.catchupTotal > 0 ? `
  <div class="catchup-bar-wrap" style="background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px;margin-bottom:20px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <span style="font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.06em">Catch-up Progress</span>
      <span style="font-size:12px;color:#6b7280">${Math.round(stats.catchupDone/stats.catchupTotal*100)}%</span>
    </div>
    <div class="catchup-bar"><div class="catchup-bar-fill" style="width:${Math.round(stats.catchupDone/stats.catchupTotal*100)}%"></div></div>
    <div class="catchup-info" style="margin-top:6px"><span>${stats.catchupDone} / ${stats.catchupTotal} replied</span><span>${catchingUp ? '⏳ Running…' : 'Complete'}</span></div>
  </div>` : ''}

  <!-- Scanner -->
  <div class="scanner">
    <div class="scanner-header">
      <div class="scanner-title">Unreplied Comments Scanner</div>
      <div class="scanner-btns">
        <a href="/bot/scan" class="sbtn">⟳ Scan now</a>
        ${!catchingUp && !isQuotaExhausted() ? `<a href="/bot/catchup" class="sbtn sbtn-primary">⊕ Catch up all (${remaining} left today)</a>` : ''}
        ${isQuotaExhausted() ? `<span class="sbtn" style="opacity:.5;cursor:not-allowed">⏳ Come back in ${timeUntilReset()}</span>` : ''}
        ${catchingUp ? `<span class="sbtn" style="opacity:.5;cursor:not-allowed">⏳ Catching up… ${stats.catchupDone}/${stats.catchupTotal}</span>` : ''}
      </div>
    </div>

    <!-- Filter tabs -->
    <div class="filter-tabs">
      <a href="/?filter=all"   class="ftab ${filter==='all'?'active':''}">All (${unreplied.length})</a>
      <a href="/?filter=today" class="ftab ${filter==='today'?'active':''}">Today (${todayComments.length})</a>
      <a href="/?filter=week"  class="ftab ${filter==='week'?'active':''}">This week (${weekComments.length})</a>
      <a href="/?filter=month" class="ftab ${filter==='month'?'active':''}">This month (${monthComments.length})</a>
      <a href="/?filter=older" class="ftab ${filter==='older'?'active':''}">Older (${olderComments.length})</a>
    </div>

    <!-- Comment list -->
    ${displayComments.length === 0 ? `<div style="text-align:center;padding:32px;color:#4b5563;font-size:13px">${scannedComments.length === 0 ? 'Click "Scan now" to load your comments' : 'No comments in this filter'}</div>` : ''}
    ${displayComments.slice(0, 8).map(c => `
    <div class="comment-card">
      <div class="avatar">${c.avatar}</div>
      <div class="comment-body">
        <div class="comment-meta">
          <span class="comment-author">${esc(c.author)}</span>
          <span class="comment-on">on "Video"</span>
        </div>
        <div class="comment-text">"${esc(c.text.slice(0,120))}${c.text.length>120?'…':''}"</div>
        <div class="comment-time">${fmtTime(c.publishedAt.toISOString())}</div>
      </div>
      <div class="comment-actions">
        <span class="pill pill-unreplied">● Unreplied</span>
        <a href="/bot/reply-one/${c.id}" class="reply-btn">↩ Reply</a>
      </div>
    </div>`).join('')}

    ${displayComments.length > 8 ? `<div class="scanner-footer">Showing 8 of ${displayComments.length} unreplied · <a href="/?filter=${filter}&all=1" style="color:#60a5fa">view all ↗</a></div>` : ''}
  </div>

  <!-- Activity Log -->
  <div class="log-panel">
    <div class="panel-title" style="margin-bottom:14px">Activity Log</div>
    <ul class="log-list">
      ${logs.length === 0 ? '<li style="padding:16px 0;text-align:center;color:#4b5563;font-size:12px">No activity yet…</li>' : ''}
      ${logs.map(l => `
      <li class="log-item">
        <span class="log-time">${new Date(l.time).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',second:'2-digit'})}</span>
        <span class="log-icon" style="background:${(logColors[l.type]||'#6b7280')}22;color:${logColors[l.type]||'#6b7280'}">${logIcons[l.type]||'›'}</span>
        <span class="log-msg">${esc(l.msg)}</span>
        ${l.badge ? `<span class="log-badge">${esc(l.badge)}</span>` : ''}
      </li>`).join('')}
    </ul>
  </div>

</main>
</body></html>`);
});

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// Routes
app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.send('Error: GOOGLE_CLIENT_ID not set.');
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
    log('YouTube reconnected successfully!', 'success');
    res.redirect('/');
  } catch(e) { res.send('Auth error: ' + e.message); }
});

app.get('/bot/start',   (req, res) => { startBot(); res.redirect('/'); });
app.get('/bot/stop',    (req, res) => { stopBot();  res.redirect('/'); });
app.get('/bot/run-now', async (req, res) => { res.redirect('/'); await runBotCycle(); });
app.get('/bot/catchup', async (req, res) => { res.redirect('/'); runCatchUp(); });
app.get('/bot/scan',    async (req, res) => {
  res.redirect('/');
  if (!refreshToken) return;
  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    scannedComments = await scanComments(auth, channelId, 5);
    stats.unrepliedCount = scannedComments.filter(c => !c.replied && !c.isOwn).length;
    log(`Scanned ${scannedComments.length} comments — ${stats.unrepliedCount} unreplied`, 'success');
  } catch(e) { log('Scan error: ' + e.message, 'error'); }
});
app.get('/bot/reply-one/:id', async (req, res) => {
  res.redirect('/');
  const c = scannedComments.find(x => x.id === req.params.id);
  if (!c || c.replied) return;
  try {
    const auth = await getAuthClient();
    const reply = await generateReply(c.text);
    await postReply(auth, c.id, reply);
    repliedIds.add(c.id);
    c.replied = true;
    stats.totalReplied++;
    if (stats.unrepliedCount) stats.unrepliedCount--;
    log(`Replied to ${c.author}`, 'success', `+${REPLY_COST_UNITS} units`);
  } catch(e) { log('Reply error: ' + e.message, 'error'); }
});
app.get('/bot/interval/:mins', (req, res) => {
  const mins = parseInt(req.params.mins);
  if ([15,60,360,1440,10080,43200].includes(mins)) setInterval2(mins);
  res.redirect('/');
});
app.get('/bot/autopause/:pct', (req, res) => {
  const pct = parseInt(req.params.pct);
  if ([70,80,90,95].includes(pct)) { autoPauseAt = pct; log(`Auto-pause set to ${pct}%`, 'success'); }
  res.redirect('/');
});
app.get('/debug', (req, res) => res.json({ connected: !!refreshToken, botRunning, catchingUp, checkIntervalMins, autoPauseAt, stats }));

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, 'success');
  if (refreshToken) { log('Starting bot automatically', 'success'); startBot(); }
});
