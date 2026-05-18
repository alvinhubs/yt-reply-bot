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

// YouTube quota resets at midnight Pacific Time daily
// Safe limit: 120 replies per day (each reply costs ~50-100 quota units, daily limit is 10,000)
const SAFE_DAILY_LIMIT    = 100;
const QUOTA_RESET_HOUR_PT = 0; // midnight Pacific

let refreshToken      = process.env.GOOGLE_REFRESH_TOKEN || null;
let botRunning        = false;
let botInterval       = null;
let catchingUp        = false;
let checkIntervalMins = 15;
let logs              = [];
let repliedIds        = new Set();

let stats = {
  replied: 0,
  errors: 0,
  lastRun: null,
  catchupTotal: 0,
  catchupDone: 0,
  unrepliedCount: null,
  dailyReplies: 0,
  dailyResetAt: getNextResetTime(),
  quotaExhausted: false,
  lastQuotaHit: null
};

function getNextResetTime() {
  // YouTube quota resets at midnight Pacific (UTC-7 or UTC-8)
  const now = new Date();
  const ptOffset = -7 * 60; // PDT, use -8 for PST
  const ptNow = new Date(now.getTime() + (ptOffset + now.getTimezoneOffset()) * 60000);
  const reset = new Date(ptNow);
  reset.setHours(24, 0, 0, 0); // next midnight PT
  // Convert back to UTC
  return new Date(reset.getTime() - (ptOffset + now.getTimezoneOffset()) * 60000);
}

function checkDailyReset() {
  const now = new Date();
  if (now >= stats.dailyResetAt) {
    stats.dailyReplies = 0;
    stats.quotaExhausted = false;
    stats.dailyResetAt = getNextResetTime();
    log('Daily quota reset! Ready to reply again.', 'success');
  }
}

function formatTimeUntilReset() {
  const now = new Date();
  const diff = stats.dailyResetAt - now;
  if (diff <= 0) return 'Resetting now...';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function formatResetTime() {
  return stats.dailyResetAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZoneName: 'short' });
}

function log(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 300) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function getRedirectUri() {
  return process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
}

async function getAuthenticatedClient() {
  if (!refreshToken) throw new Error('Not authenticated. Visit /auth to connect YouTube.');
  const oauth2 = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();
  oauth2.setCredentials(credentials);
  return oauth2;
}

async function getChannelId(auth) {
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.channels.list({ part: 'id', mine: true });
  return res.data.items[0].id;
}

// Count total unreplied comments
async function countUnrepliedComments(auth, channelId) {
  const yt = google.youtube({ version: 'v3', auth });
  let total = 0;
  let pageToken = null;
  let pages = 0;
  while (pages < 5) { // max 5 pages = 500 comments scan
    const params = { part: 'snippet', allThreadsRelatedToChannelId: channelId, maxResults: 100, moderationStatus: 'published' };
    if (pageToken) params.pageToken = pageToken;
    try {
      const res = await yt.commentThreads.list(params);
      const items = res.data.items || [];
      const unreplied = items.filter(t => {
        const s = t.snippet.topLevelComment.snippet;
        return !s.authorIsChannelOwner && t.snippet.totalReplyCount === 0 && !repliedIds.has(t.snippet.topLevelComment.id);
      });
      total += unreplied.length;
      pageToken = res.data.nextPageToken;
      pages++;
      if (!pageToken) break;
      await sleep(300);
    } catch(e) { break; }
  }
  return total;
}

async function fetchBatchUnreplied(auth, channelId, limit = SAFE_DAILY_LIMIT) {
  const yt = google.youtube({ version: 'v3', auth });
  let results = [];
  let pageToken = null;
  while (results.length < limit) {
    const params = { part: 'snippet', allThreadsRelatedToChannelId: channelId, maxResults: 100, order: 'time', moderationStatus: 'published' };
    if (pageToken) params.pageToken = pageToken;
    const res = await yt.commentThreads.list(params);
    const items = res.data.items || [];
    const unreplied = items.filter(t => {
      const s = t.snippet.topLevelComment.snippet;
      return !s.authorIsChannelOwner && t.snippet.totalReplyCount === 0 && !repliedIds.has(t.snippet.topLevelComment.id);
    });
    results = results.concat(unreplied);
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
    await sleep(300);
  }
  return results.slice(0, limit);
}

async function getRecentUnreplied(auth, channelId) {
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.commentThreads.list({ part: 'snippet', allThreadsRelatedToChannelId: channelId, maxResults: 50, order: 'time', moderationStatus: 'published' });
  return (res.data.items || []).filter(t => {
    const s = t.snippet.topLevelComment.snippet;
    return !s.authorIsChannelOwner && t.snippet.totalReplyCount === 0 && !repliedIds.has(t.snippet.topLevelComment.id);
  });
}

async function postReply(auth, parentId, text) {
  const yt = google.youtube({ version: 'v3', auth });
  await yt.comments.insert({ part: 'snippet', requestBody: { snippet: { parentId, textOriginal: text } } });
}

async function generateReply(commentText) {
  const system = `You are a YouTube creator named "${CHANNEL_NAME}". Reply to a YouTube comment in a ${REPLY_TONE} tone. Keep it ${REPLY_LENGTH}. Be authentic. Return ONLY the reply text.`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': CLAUDE_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 150, system, messages: [{ role: 'user', content: commentText }] })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text.trim();
}

async function replyToThread(auth, thread) {
  const s = thread.snippet.topLevelComment.snippet;
  const id = thread.snippet.topLevelComment.id;
  const reply = await generateReply(s.textDisplay);
  await postReply(auth, id, reply);
  repliedIds.add(id);
  stats.replied++;
  stats.dailyReplies++;
  if (stats.unrepliedCount !== null) stats.unrepliedCount = Math.max(0, stats.unrepliedCount - 1);
  log(`Replied to ${s.authorDisplayName}: "${s.textDisplay.slice(0, 55)}…"`, 'success');
}

async function runBotCycle() {
  if (!refreshToken) { log('No YouTube auth — visit /auth to reconnect', 'warn'); return; }
  checkDailyReset();
  if (stats.quotaExhausted) {
    log(`Quota exhausted — resets in ${formatTimeUntilReset()} at ${formatResetTime()}`, 'warn');
    return;
  }
  stats.lastRun = new Date().toISOString();
  log('Checking for new comments…');
  try {
    const auth = await getAuthenticatedClient();
    const channelId = await getChannelId(auth);
    const canReply = SAFE_DAILY_LIMIT - stats.dailyReplies;
    if (canReply <= 0) {
      stats.quotaExhausted = true;
      log(`Daily limit reached (${SAFE_DAILY_LIMIT}). Resets in ${formatTimeUntilReset()}`, 'warn');
      return;
    }
    const threads = await getRecentUnreplied(auth, channelId);
    const toReply = threads.slice(0, Math.min(canReply, threads.length));
    log(`Found ${threads.length} unreplied — replying to ${toReply.length}`);
    for (const thread of toReply) {
      if (stats.dailyReplies >= SAFE_DAILY_LIMIT) {
        stats.quotaExhausted = true;
        log(`Daily limit reached. Resets in ${formatTimeUntilReset()}`, 'warn');
        break;
      }
      try { await replyToThread(auth, thread); await sleep(2000); }
      catch (e) {
        if (e.message.includes('quota')) {
          stats.quotaExhausted = true;
          stats.lastQuotaHit = new Date().toISOString();
          log(`Quota hit — resets in ${formatTimeUntilReset()} at ${formatResetTime()}`, 'warn');
          break;
        }
        stats.errors++;
        log(`Error: ${e.message}`, 'error');
      }
    }
    // Update unreplied count
    try { stats.unrepliedCount = await countUnrepliedComments(auth, channelId); } catch(e) {}
    log('Cycle complete ✓', 'success');
  } catch (e) {
    if (e.message.includes('invalid_grant')) {
      log('YouTube session expired — please reconnect at /auth', 'error');
      stopBot();
    } else {
      stats.errors++;
      log(`Cycle error: ${e.message}`, 'error');
    }
  }
}

async function runCatchUp() {
  if (catchingUp) { log('Catch-up already running', 'warn'); return; }
  if (!refreshToken) { log('Not connected — visit /auth', 'error'); return; }
  checkDailyReset();
  if (stats.quotaExhausted) {
    log(`Quota exhausted — resets in ${formatTimeUntilReset()} at ${formatResetTime()}`, 'warn');
    return;
  }
  const canReply = SAFE_DAILY_LIMIT - stats.dailyReplies;
  if (canReply <= 0) {
    stats.quotaExhausted = true;
    log(`Daily limit reached. Come back after ${formatResetTime()}`, 'warn');
    return;
  }
  catchingUp = true;
  log(`Catch-up started — will reply to up to ${canReply} comments today`, 'success');
  try {
    const auth = await getAuthenticatedClient();
    const channelId = await getChannelId(auth);
    const threads = await fetchBatchUnreplied(auth, channelId, canReply);
    stats.catchupTotal = threads.length;
    stats.catchupDone  = 0;
    log(`Found ${threads.length} unreplied comments — starting replies…`, 'success');
    for (const thread of threads) {
      if (stats.dailyReplies >= SAFE_DAILY_LIMIT) {
        stats.quotaExhausted = true;
        log(`Daily limit of ${SAFE_DAILY_LIMIT} reached! Come back after ${formatResetTime()} to continue.`, 'warn');
        break;
      }
      try {
        await replyToThread(auth, thread);
        stats.catchupDone++;
        await sleep(2000);
      } catch (e) {
        if (e.message.includes('quota')) {
          stats.quotaExhausted = true;
          stats.lastQuotaHit = new Date().toISOString();
          log(`Quota hit after ${stats.catchupDone} replies. Come back after ${formatResetTime()}`, 'warn');
          break;
        }
        stats.errors++;
        stats.catchupDone++;
        log(`Failed: ${e.message}`, 'error');
      }
    }
    try { stats.unrepliedCount = await countUnrepliedComments(auth, channelId); } catch(e) {}
    if (!stats.quotaExhausted) {
      log(`Catch-up complete! Replied to ${stats.catchupDone} comments.`, 'success');
    }
  } catch (e) {
    if (e.message.includes('invalid_grant')) {
      log('YouTube session expired — please reconnect at /auth', 'error');
    } else {
      log(`Catch-up error: ${e.message}`, 'error');
    }
  }
  catchingUp = false;
}

function setCheckInterval(mins) {
  checkIntervalMins = mins;
  if (botRunning) {
    clearInterval(botInterval);
    botInterval = setInterval(runBotCycle, mins * 60 * 1000);
  }
  log(`Check interval set to ${formatInterval(mins)}`, 'success');
}

function formatInterval(mins) {
  if (mins < 60) return `${mins} minutes`;
  if (mins < 1440) return `${mins/60} hours`;
  if (mins === 1440) return 'daily';
  if (mins === 10080) return 'weekly';
  return `${mins} minutes`;
}

function startBot() {
  if (botRunning) return;
  botRunning = true;
  log(`Bot started — checking every ${formatInterval(checkIntervalMins)}`, 'success');
  runBotCycle();
  botInterval = setInterval(runBotCycle, checkIntervalMins * 60 * 1000);
}

function stopBot() {
  if (!botRunning) return;
  clearInterval(botInterval);
  botRunning = false;
  log('Bot stopped', 'warn');
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const connected   = !!refreshToken;
  const statusColor = botRunning ? '#2ecc71' : connected ? '#f0a500' : '#e74c3c';
  const statusText  = botRunning ? 'Running' : connected ? 'Paused' : 'Not connected';
  const quotaColor  = stats.quotaExhausted ? '#e74c3c' : '#2ecc71';
  const quotaText   = stats.quotaExhausted ? 'Exhausted' : 'Available';
  const catchupPct  = stats.catchupTotal > 0 ? Math.round((stats.catchupDone / stats.catchupTotal) * 100) : 0;
  const remaining   = SAFE_DAILY_LIMIT - stats.dailyReplies;

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlvinHub AI Reply Bot</title>
<meta http-equiv="refresh" content="15">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f0f0f;color:#f1f1f1;min-height:100vh}
header{display:flex;align-items:center;gap:12px;padding:16px 24px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,0.1);position:sticky;top:0;z-index:10}
.logo{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600}
.badge{font-size:11px;background:#ff0000;color:#fff;padding:2px 7px;border-radius:4px}
.dot{width:10px;height:10px;border-radius:50%;background:${statusColor};margin-left:auto;flex-shrink:0}
main{max-width:860px;margin:0 auto;padding:28px 20px}
.card{background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:22px;margin-bottom:18px}
.card-title{font-size:12px;font-weight:600;color:#666;text-transform:uppercase;letter-spacing:.06em;margin-bottom:16px}
.stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:18px}
.stat{background:#242424;border-radius:8px;padding:14px;text-align:center;border:1px solid rgba(255,255,255,0.05)}
.stat-num{font-size:26px;font-weight:700;line-height:1}
.stat-lbl{font-size:11px;color:#666;margin-top:5px}
.status-pill{display:inline-flex;align-items:center;gap:7px;padding:5px 13px;border-radius:20px;font-size:13px;font-weight:500;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;padding:9px 18px;border-radius:8px;font-size:13px;font-weight:500;cursor:pointer;border:none;text-decoration:none;transition:opacity .15s;white-space:nowrap}
.btn-red{background:#ff0000;color:#fff}.btn-green{background:#2ecc71;color:#fff}.btn-blue{background:#3498db;color:#fff}.btn-gray{background:#2a2a2a;color:#ccc;border:1px solid rgba(255,255,255,0.1)}
.btn:hover{opacity:.85}.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-row{display:flex;gap:8px;flex-wrap:wrap}
.progress-wrap{margin-top:14px}
.progress-bar{width:100%;height:8px;background:#2a2a2a;border-radius:4px;overflow:hidden}
.progress-fill{height:100%;border-radius:4px;transition:width .3s}
.progress-info{display:flex;justify-content:space-between;font-size:12px;color:#666;margin-top:6px}
.quota-bar-fill{background:${stats.quotaExhausted ? '#e74c3c' : '#2ecc71'}}
.catchup-bar-fill{background:#3498db}
.reset-box{background:#242424;border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:14px 16px;margin-top:14px}
.reset-box h3{font-size:12px;color:#666;text-transform:uppercase;letter-spacing:.05em;margin-bottom:8px}
.reset-time{font-size:22px;font-weight:600;color:#f0a500}
.reset-sub{font-size:12px;color:#555;margin-top:4px}
.interval-row{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}
.interval-btn{padding:6px 14px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid rgba(255,255,255,0.1);background:#242424;color:#ccc;text-decoration:none;transition:all .15s}
.interval-btn:hover,.interval-btn.active{background:#3498db;color:#fff;border-color:#3498db}
.log-list{list-style:none;max-height:280px;overflow-y:auto}
.log-list li{padding:7px 0;border-bottom:1px solid rgba(255,255,255,0.05);font-size:12px;display:flex;gap:10px;align-items:flex-start}
.log-time{color:#444;flex-shrink:0;font-variant-numeric:tabular-nums}
.log-msg{color:#bbb;line-height:1.4}
.log-success .log-msg{color:#2ecc71}.log-error .log-msg{color:#e74c3c}.log-warn .log-msg{color:#f0a500}
.alert{padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:14px;display:flex;align-items:center;gap:10px}
.alert-warn{background:rgba(240,165,0,0.1);border:1px solid rgba(240,165,0,0.25);color:#f0a500}
.alert-error{background:rgba(231,76,60,0.1);border:1px solid rgba(231,76,60,0.25);color:#e74c3c}
.unreplied-big{font-size:48px;font-weight:700;color:#fff;line-height:1}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:14px}
@media(max-width:600px){.two-col{grid-template-columns:1fr}.stats-grid{grid-template-columns:1fr 1fr}}
</style>
</head>
<body>
<header>
  <div class="logo">
    <svg width="28" height="20" viewBox="0 0 90 63"><rect width="90" height="63" rx="14" fill="#FF0000"/><path d="M37 20l24 11.5L37 43V20z" fill="white"/></svg>
    AlvinHub AI Reply Bot <span class="badge">AI</span>
  </div>
  <div class="dot" title="${statusText}"></div>
</header>

<main>

  ${!connected ? `<div class="alert alert-error">⚠️ YouTube not connected. <a href="/auth" style="color:#e74c3c;font-weight:600;margin-left:4px">Reconnect now →</a></div>` : ''}
  ${connected && stats.quotaExhausted ? `<div class="alert alert-warn">⏳ Daily quota reached — resets in <strong>${formatTimeUntilReset()}</strong> at ${formatResetTime()}. Click "Catch up" again after reset.</div>` : ''}

  <!-- Status + Controls -->
  <div class="card">
    <div class="card-title">Bot Status</div>
    <div class="status-pill" style="background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44">● ${statusText}</div>

    <div class="stats-grid">
      <div class="stat">
        <div class="unreplied-big">${stats.unrepliedCount !== null ? stats.unrepliedCount : '—'}</div>
        <div class="stat-lbl">Unreplied comments left</div>
      </div>
      <div class="stat">
        <div class="stat-num" style="color:#2ecc71">${stats.replied}</div>
        <div class="stat-lbl">Total replies posted</div>
      </div>
      <div class="stat">
        <div class="stat-num" style="color:${quotaColor}">${stats.dailyReplies} / ${SAFE_DAILY_LIMIT}</div>
        <div class="stat-lbl">Today's replies used</div>
      </div>
      <div class="stat">
        <div class="stat-num" style="font-size:14px;padding-top:6px">${stats.lastRun ? new Date(stats.lastRun).toLocaleTimeString() : '—'}</div>
        <div class="stat-lbl">Last check</div>
      </div>
    </div>

    <!-- Quota progress bar -->
    <div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill quota-bar-fill" style="width:${Math.min(100,(stats.dailyReplies/SAFE_DAILY_LIMIT)*100)}%"></div></div>
      <div class="progress-info"><span>Daily quota: ${stats.dailyReplies} / ${SAFE_DAILY_LIMIT} used</span><span>${remaining > 0 ? remaining + ' remaining today' : 'Limit reached'}</span></div>
    </div>

    <!-- Reset timer -->
    <div class="reset-box">
      <h3>🔄 Quota resets in</h3>
      <div class="reset-time">${formatTimeUntilReset()}</div>
      <div class="reset-sub">at ${formatResetTime()} — then click "Catch up old comments" to continue</div>
    </div>

    <!-- Controls -->
    <div class="btn-row" style="margin-top:16px">
      ${!connected ? `<a href="/auth" class="btn btn-red">Connect YouTube</a>` : ''}
      ${connected && !botRunning ? `<a href="/bot/start" class="btn btn-green">▶ Start bot</a>` : ''}
      ${botRunning ? `<a href="/bot/stop" class="btn btn-gray">⏹ Stop bot</a>` : ''}
      ${connected ? `<a href="/bot/run-now" class="btn btn-gray">⚡ Run now</a>` : ''}
      ${connected && !catchingUp && !stats.quotaExhausted ? `<a href="/bot/catchup" class="btn btn-blue">🔄 Catch up old comments (${remaining} left today)</a>` : ''}
      ${connected && !catchingUp && stats.quotaExhausted ? `<span class="btn btn-gray" style="opacity:.5;cursor:not-allowed">⏳ Come back in ${formatTimeUntilReset()}</span>` : ''}
      ${catchingUp ? `<span class="btn btn-gray" style="opacity:.5;cursor:not-allowed">⏳ Catching up… ${stats.catchupDone}/${stats.catchupTotal}</span>` : ''}
    </div>

    <!-- Catch-up progress -->
    ${stats.catchupTotal > 0 ? `
    <div class="progress-wrap">
      <div class="progress-bar"><div class="progress-fill catchup-bar-fill" style="width:${catchupPct}%"></div></div>
      <div class="progress-info"><span>Catch-up: ${stats.catchupDone} / ${stats.catchupTotal} replied</span><span>${catchupPct}%</span></div>
    </div>` : ''}
  </div>

  <!-- Check Interval -->
  <div class="card">
    <div class="card-title">Auto-check interval</div>
    <p style="font-size:13px;color:#666;margin-bottom:12px">How often the bot checks for new comments automatically</p>
    <div class="interval-row">
      <a href="/bot/interval/15"   class="interval-btn ${checkIntervalMins===15?'active':''}">Every 15 min</a>
      <a href="/bot/interval/60"   class="interval-btn ${checkIntervalMins===60?'active':''}">Every hour</a>
      <a href="/bot/interval/360"  class="interval-btn ${checkIntervalMins===360?'active':''}">Every 6 hours</a>
      <a href="/bot/interval/1440" class="interval-btn ${checkIntervalMins===1440?'active':''}">Daily</a>
      <a href="/bot/interval/10080" class="interval-btn ${checkIntervalMins===10080?'active':''}">Weekly</a>
    </div>
  </div>

  <!-- Activity Log -->
  <div class="card">
    <div class="card-title">Activity Log</div>
    <ul class="log-list">
      ${logs.length === 0 ? '<li><span class="log-msg" style="color:#444">No activity yet…</span></li>' : ''}
      ${logs.map(l => `<li class="log-${l.type}"><span class="log-time">${new Date(l.time).toLocaleTimeString()}</span><span class="log-msg">${l.msg}</span></li>`).join('')}
    </ul>
  </div>

</main>
</body></html>`);
});

app.get('/debug', (req, res) => {
  res.json({ connected: !!refreshToken, botRunning, catchingUp, checkIntervalMins, stats, nextReset: stats.dailyResetAt });
});

app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) return res.send('Error: GOOGLE_CLIENT_ID not set.');
  const oauth2 = new google.auth.OAuth2(clientId, process.env.GOOGLE_CLIENT_SECRET, getRedirectUri());
  const url = oauth2.generateAuthUrl({ access_type: 'offline', prompt: 'consent', scope: ['https://www.googleapis.com/auth/youtube.force-ssl'] });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Error: no code received');
  try {
    const oauth2 = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, getRedirectUri());
    const { tokens } = await oauth2.getToken(code);
    refreshToken = tokens.refresh_token;
    stats.quotaExhausted = false;
    log('YouTube reconnected successfully!', 'success');
    res.redirect('/');
  } catch (e) { log('Auth error: ' + e.message, 'error'); res.send('Auth error: ' + e.message); }
});

app.get('/bot/start',   (req, res) => { startBot(); res.redirect('/'); });
app.get('/bot/stop',    (req, res) => { stopBot();  res.redirect('/'); });
app.get('/bot/run-now', async (req, res) => { res.redirect('/'); await runBotCycle(); });
app.get('/bot/catchup', async (req, res) => { res.redirect('/'); runCatchUp(); });
app.get('/bot/interval/:mins', (req, res) => {
  const mins = parseInt(req.params.mins);
  if ([15, 60, 360, 1440, 10080].includes(mins)) setCheckInterval(mins);
  res.redirect('/');
});

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, 'success');
  if (refreshToken) { log('Starting bot automatically', 'success'); startBot(); }
});
