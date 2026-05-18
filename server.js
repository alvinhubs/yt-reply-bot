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

let refreshToken      = process.env.GOOGLE_REFRESH_TOKEN || null;
let botRunning        = false;
let botInterval       = null;
let catchingUp        = false;
let checkIntervalMins = 15;
let autoPauseAt       = 90;
let logs              = [];
let repliedIds        = new Set(); // tracks IDs we replied to this session
let channelOwnerId    = null;      // cached channel ID to check owner replies

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
    repliedIds = new Set(); // reset session tracking
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
  stats.quotaUsed += READ_COST_UNITS;
  const res = await yt.channels.list({ part: 'id', mine: true });
  channelOwnerId = res.data.items[0].id;
  return channelOwnerId;
}

// ── KEY FIX: Check if OWNER has replied, not just any reply ──────────────────
async function ownerHasReplied(auth, threadId) {
  if (!channelOwnerId) return false;
  try {
    const yt = google.youtube({ version: 'v3', auth });
    stats.quotaUsed += READ_COST_UNITS;
    const res = await yt.comments.list({
      part: 'snippet',
      parentId: threadId,
      maxResults: 20
    });
    const replies = res.data.items || [];
    return replies.some(r => r.snippet.authorChannelId?.value === channelOwnerId);
  } catch(e) {
    return false;
  }
}

// ── Scan ALL comments including old ones ──────────────────────────────────────
async function scanAllComments(auth, channelId, maxPages = 20) {
  const yt = google.youtube({ version: 'v3', auth });
  let all = [];
  let pageToken = null;
  let pages = 0;

  log(`Scanning up to ${maxPages * 100} comments (including old ones)...`);

  while (pages < maxPages) {
    const params = {
      part: 'snippet',
      allThreadsRelatedToChannelId: channelId,
      maxResults: 100,
      // NOTE: removed order:'time' to get all comments not just recent
      moderationStatus: 'published'
    };
    if (pageToken) params.pageToken = pageToken;
    stats.quotaUsed += READ_COST_UNITS;

    try {
      const res = await yt.commentThreads.list(params);
      const items = res.data.items || [];

      for (const t of items) {
        const s = t.snippet.topLevelComment.snippet;
        const id = t.snippet.topLevelComment.id;

        // Skip own comments
        if (s.authorIsChannelOwner) continue;
        // Skip if we already replied this session
        if (repliedIds.has(id)) continue;

        // KEY FIX: If no replies at all → definitely unreplied → add it
        // If has replies → check if OWNER specifically replied
        let isUnreplied = false;
        if (t.snippet.totalReplyCount === 0) {
          isUnreplied = true;
        } else {
          // Has some replies - check if owner replied
          const ownerReplied = await ownerHasReplied(auth, id);
          isUnreplied = !ownerReplied;
          await sleep(100); // small delay to avoid rate limiting
        }

        if (isUnreplied) {
          all.push({
            id,
            threadId: t.id,
            author: s.authorDisplayName,
            text: s.textDisplay,
            publishedAt: new Date(s.publishedAt),
            isOwn: false,
            replied: false
          });
        }
      }

      pageToken = res.data.nextPageToken;
      pages++;
      if (!pageToken) break;
      await sleep(200);
    } catch(e) {
      if (e.message.includes('quota')) throw e;
      log(`Scan page error: ${e.message}`, 'error');
      break;
    }
  }

  log(`Found ${all.length} unreplied comments across ${pages} pages`, 'success');
  return all;
}

// ── Faster scan for recent comments (regular bot cycle) ───────────────────────
async function scanRecentComments(auth, channelId) {
  const yt = google.youtube({ version: 'v3', auth });
  let all = [];
  let pageToken = null;
  let pages = 0;

  while (pages < 3) {
    const params = {
      part: 'snippet',
      allThreadsRelatedToChannelId: channelId,
      maxResults: 100,
      order: 'time',
      moderationStatus: 'published'
    };
    if (pageToken) params.pageToken = pageToken;
    stats.quotaUsed += READ_COST_UNITS;

    const res = await yt.commentThreads.list(params);
    const items = res.data.items || [];

    for (const t of items) {
      const s = t.snippet.topLevelComment.snippet;
      const id = t.snippet.topLevelComment.id;
      if (s.authorIsChannelOwner) continue;
      if (repliedIds.has(id)) continue;
      if (t.snippet.totalReplyCount === 0) {
        all.push({
          id, threadId: t.id,
          author: s.authorDisplayName,
          text: s.textDisplay,
          publishedAt: new Date(s.publishedAt),
          replied: false
        });
      }
    }

    pageToken = res.data.nextPageToken;
    pages++;
    if (!pageToken) break;
    await sleep(200);
  }

  return all;
}

async function postReply(auth, parentId, text) {
  const yt = google.youtube({ version: 'v3', auth });
  stats.quotaUsed += REPLY_COST_UNITS;
  await yt.comments.insert({
    part: 'snippet',
    requestBody: { snippet: { parentId, textOriginal: text } }
  });
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

async function runBotCycle() {
  if (!refreshToken) { log('Not connected — visit /auth', 'warn'); return; }
  checkDailyReset();
  if (isQuotaExhausted()) {
    log(`Quota at ${autoPauseAt}% — resets in ${timeUntilReset()}`, 'warn');
    return;
  }
  stats.lastRun = new Date().toISOString();
  log('Checking for new comments…');
  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);
    const comments = await scanRecentComments(auth, channelId);
    stats.unrepliedCount = comments.length;
    log(`Found ${comments.length} unreplied recent comments`);

    for (const c of comments) {
      if (isQuotaExhausted()) {
        log(`Quota at ${autoPauseAt}% — pausing. Resets in ${timeUntilReset()}`, 'warn');
        break;
      }
      try {
        const reply = await generateReply(c.text);
        await postReply(auth, c.id, reply);
        repliedIds.add(c.id);
        stats.totalReplied++;
        log(`Replied to ${c.author}: "${c.text.slice(0, 55)}…"`, 'success', `+${REPLY_COST_UNITS} units`);
        await sleep(2000);
      } catch(e) {
        if (e.message.includes('quota')) {
          log(`Quota hit — resets in ${timeUntilReset()}`, 'warn');
          break;
        }
        log(`Failed: ${e.message}`, 'error');
      }
    }
    log('Cycle complete ✓', 'success');
  } catch(e) {
    if (e.message.includes('invalid_grant')) {
      log('YouTube session expired — reconnect at /auth', 'error');
      stopBot();
    } else {
      log(`Cycle error: ${e.message}`, 'error');
    }
  }
}

// ── CATCH UP: scans ALL old comments including from last year ─────────────────
async function runCatchUp() {
  if (catchingUp || !refreshToken) return;
  checkDailyReset();
  if (isQuotaExhausted()) {
    log(`Quota exhausted — come back in ${timeUntilReset()}`, 'warn');
    return;
  }
  const canReply = repliesRemainingToday();
  if (canReply <= 0) {
    log(`Daily limit reached. Come back in ${timeUntilReset()}`, 'warn');
    return;
  }

  catchingUp = true;
  log(`Catch-up started — scanning ALL comments including old ones from last year…`, 'success');

  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);

    // Scan deeply — 20 pages = up to 2000 comments, includes old ones
    const comments = await scanAllComments(auth, channelId, 20);
    stats.unrepliedCount = comments.length;
    stats.catchupTotal = Math.min(comments.length, canReply);
    stats.catchupDone  = 0;

    log(`Found ${comments.length} total unreplied (including old) — replying to ${stats.catchupTotal} today`, 'success');

    // Sort oldest first so old comments get replied to first
    comments.sort((a, b) => a.publishedAt - b.publishedAt);

    for (const c of comments.slice(0, canReply)) {
      if (isQuotaExhausted()) {
        log(`Daily limit reached after ${stats.catchupDone} replies. Come back in ${timeUntilReset()}`, 'warn');
        break;
      }
      try {
        const reply = await generateReply(c.text);
        await postReply(auth, c.id, reply);
        repliedIds.add(c.id);
        stats.totalReplied++;
        stats.catchupDone++;
        const age = getAge(c.publishedAt);
        log(`[${stats.catchupDone}/${stats.catchupTotal}] Replied to ${c.author} (${age}): "${c.text.slice(0, 45)}…"`, 'success', `+${REPLY_COST_UNITS} units`);
        await sleep(2000);
      } catch(e) {
        if (e.message.includes('quota')) {
          log(`Quota hit after ${stats.catchupDone} replies. Come back in ${timeUntilReset()}`, 'warn');
          break;
        }
        stats.catchupDone++;
        log(`Failed: ${e.message}`, 'error');
      }
    }

    stats.unrepliedCount = Math.max(0, comments.length - stats.catchupDone);
    if (!isQuotaExhausted()) {
      log(`Catch-up complete! Replied to ${stats.catchupDone} comments including old ones.`, 'success');
    }
  } catch(e) {
    if (e.message.includes('invalid_grant')) log('Session expired — reconnect at /auth', 'error');
    else log(`Catch-up error: ${e.message}`, 'error');
  }
  catchingUp = false;
}

function getAge(date) {
  const diff = Date.now() - date;
  const days = Math.floor(diff / 86400000);
  if (days === 0) return 'today';
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days/7)}w ago`;
  if (days < 365) return `${Math.floor(days/30)}mo ago`;
  return `${Math.floor(days/365)}y ago`;
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

function setIntervalMins(mins) {
  checkIntervalMins = mins;
  if (botRunning) {
    clearInterval(botInterval);
    botInterval = setInterval(runBotCycle, mins * 60 * 1000);
  }
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

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Dashboard ──────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  checkDailyReset();
  const connected   = !!refreshToken;
  const quotaPct    = Math.min(100, Math.round((stats.quotaUsed / DAILY_QUOTA_UNITS) * 100));
  const quotaColor  = quotaPct >= autoPauseAt ? '#ef4444' : quotaPct > 70 ? '#f59e0b' : '#22c55e';
  const statusText  = !connected ? 'Not connected' : isQuotaExhausted() ? 'Paused — quota exceeded' : botRunning ? 'Running' : 'Paused';
  const statusDot   = !connected ? '#ef4444' : isQuotaExhausted() ? '#f59e0b' : botRunning ? '#22c55e' : '#f59e0b';
  const remaining   = repliesRemainingToday();
  const catchupPct  = stats.catchupTotal > 0 ? Math.round((stats.catchupDone / stats.catchupTotal) * 100) : 0;
  const logIcons    = { success: '✓', error: '✕', warn: '⚠', info: '›' };
  const logColors   = { success: '#22c55e', error: '#ef4444', warn: '#f59e0b', info: '#6b7280' };

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlvinHub AI Reply Bot</title>
<meta http-equiv="refresh" content="20">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0a0a0a;color:#e5e7eb;min-height:100vh;font-size:14px}
.header{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;background:#111;border-bottom:1px solid #1f1f1f;position:sticky;top:0;z-index:100}
.header-left{display:flex;align-items:center;gap:10px}
.yt-icon{width:32px;height:22px;background:#ff0000;border-radius:6px;display:flex;align-items:center;justify-content:center}
.yt-icon svg{width:14px;height:14px;fill:white}
.header-title{font-size:15px;font-weight:600}
.header-status{display:flex;align-items:center;gap:6px;font-size:12px;color:#9ca3af;margin-top:2px}
.sdot{width:7px;height:7px;border-radius:50%;background:${statusDot}}
.hbtns{display:flex;gap:8px}
.hbtn{display:flex;align-items:center;gap:6px;padding:7px 14px;border-radius:7px;font-size:13px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#1a1a1a;color:#e5e7eb;text-decoration:none;transition:all .15s}
.hbtn:hover{background:#252525}
.hbtn-primary{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
.hbtn-primary:hover{background:#1e40af}
main{max-width:900px;margin:0 auto;padding:24px 20px}
.stats-row{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px}
.stat-box{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px 18px}
.stat-label{font-size:11px;color:#6b7280;margin-bottom:6px;text-transform:uppercase;letter-spacing:.04em}
.stat-value{font-size:28px;font-weight:700;line-height:1;color:#f9fafb}
.stat-sub{font-size:11px;color:#6b7280;margin-top:4px}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:20px}
.panel{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:18px}
.panel-title{font-size:11px;font-weight:600;color:#6b7280;text-transform:uppercase;letter-spacing:.06em;margin-bottom:14px}
.qbar-label{display:flex;justify-content:space-between;font-size:12px;margin-bottom:6px}
.qbar{width:100%;height:6px;background:#1f1f1f;border-radius:3px;overflow:hidden}
.qbar-fill{height:100%;border-radius:3px;background:${quotaColor};width:${quotaPct}%}
.qs{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px}
.qb{background:#0f0f0f;border-radius:6px;padding:10px;text-align:center}
.qb-val{font-size:13px;font-weight:600;color:#f9fafb}
.qb-lbl{font-size:10px;color:#6b7280;margin-top:2px}
.quota-tip{background:#0f172a;border:1px solid #1e3a5f;border-radius:8px;padding:12px;font-size:12px;color:#60a5fa}
.ibtnrow{display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-bottom:12px}
.ibtn{padding:8px 12px;border-radius:7px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#0f0f0f;color:#9ca3af;text-align:center;text-decoration:none;display:block;transition:all .15s}
.ibtn:hover{border-color:#374151;color:#e5e7eb}
.ibtn.active{background:#1d4ed8;border-color:#1d4ed8;color:#fff}
.ihint{font-size:11px;color:#6b7280;background:#0f0f0f;border-radius:6px;padding:10px;margin-bottom:14px;line-height:1.5}
.ap-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:4px}
.ap-lbl{font-size:12px;color:#9ca3af}
.ap-val{font-size:13px;font-weight:600}
.ap-sub{font-size:11px;color:#6b7280;margin-bottom:10px}
.apbtns{display:flex;gap:6px;flex-wrap:wrap}
.catch-box{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:16px;margin-bottom:20px}
.catch-box-note{font-size:12px;color:#6b7280;margin-bottom:12px;line-height:1.5;background:#0f172a;border:1px solid #1e3a5f;border-radius:7px;padding:10px;color:#60a5fa}
.pbar{width:100%;height:8px;background:#1f1f1f;border-radius:4px;overflow:hidden;margin:8px 0}
.pbar-fill{height:100%;background:#1d4ed8;border-radius:4px}
.pbar-info{display:flex;justify-content:space-between;font-size:12px;color:#6b7280}
.scanner{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:18px;margin-bottom:20px}
.scan-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.sbtnrow{display:flex;gap:8px}
.sbtn{display:flex;align-items:center;gap:6px;padding:6px 12px;border-radius:6px;font-size:12px;font-weight:500;cursor:pointer;border:1px solid #2a2a2a;background:#1a1a1a;color:#e5e7eb;text-decoration:none;transition:all .15s}
.sbtn:hover{background:#252525}
.sbtn-blue{background:#1d4ed8;border-color:#1d4ed8}
.ftabs{display:flex;gap:6px;margin-bottom:14px;flex-wrap:wrap}
.ftab{padding:5px 12px;border-radius:20px;font-size:12px;font-weight:500;text-decoration:none;border:1px solid #2a2a2a;background:#0f0f0f;color:#9ca3af;transition:all .15s}
.ftab.active{background:#1f2937;border-color:#374151;color:#f9fafb}
.empty-scan{text-align:center;padding:32px;color:#4b5563;font-size:13px}
.log-panel{background:#111;border:1px solid #1f1f1f;border-radius:10px;padding:18px}
.log-list{list-style:none;max-height:300px;overflow-y:auto}
.log-item{display:flex;align-items:flex-start;gap:12px;padding:8px 0;border-bottom:1px solid #161616}
.log-item:last-child{border-bottom:none}
.log-time{font-size:11px;color:#4b5563;flex-shrink:0;width:58px;font-variant-numeric:tabular-nums}
.log-icon{width:16px;height:16px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:700;flex-shrink:0;margin-top:1px}
.log-msg{font-size:12px;color:#9ca3af;flex:1;line-height:1.4}
.log-badge{font-size:10px;padding:2px 7px;border-radius:4px;background:#1f2937;color:#60a5fa;border:1px solid #1e3a5f;flex-shrink:0;margin-top:1px}
.alert{padding:12px 16px;border-radius:8px;font-size:13px;margin-bottom:16px;display:flex;align-items:center;gap:10px}
.alert-err{background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);color:#ef4444}
.alert-warn{background:rgba(245,158,11,0.1);border:1px solid rgba(245,158,11,0.25);color:#f59e0b}
@media(max-width:640px){.stats-row{grid-template-columns:1fr 1fr}.two-col{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="header">
  <div class="header-left">
    <div class="yt-icon"><svg viewBox="0 0 24 24"><path d="M19.6 3H4.4A4.4 4.4 0 000 7.4v9.2A4.4 4.4 0 004.4 21h15.2a4.4 4.4 0 004.4-4.4V7.4A4.4 4.4 0 0019.6 3zM9.5 15.5v-7l7 3.5-7 3.5z"/></svg></div>
    <div>
      <div class="header-title">AlvinHub AI Reply Bot</div>
      <div class="header-status"><div class="sdot"></div>${statusText}</div>
    </div>
  </div>
  <div class="hbtns">
    ${!connected ? `<a href="/auth" class="hbtn hbtn-primary">Connect YouTube</a>` : ''}
    ${connected ? `<a href="/bot/run-now" class="hbtn">▶ Run now</a>` : ''}
    ${connected && !botRunning ? `<a href="/bot/start" class="hbtn hbtn-primary">▶ Start bot</a>` : ''}
    ${botRunning ? `<a href="/bot/stop" class="hbtn">⏹ Stop bot</a>` : ''}
  </div>
</div>

<main>
  ${!connected ? `<div class="alert alert-err">⚠️ YouTube not connected. <a href="/auth" style="color:#ef4444;font-weight:600;margin-left:4px">Reconnect now →</a></div>` : ''}
  ${connected && isQuotaExhausted() ? `<div class="alert alert-warn">⏳ Daily quota reached — resets in <strong>${timeUntilReset()}</strong>. Click "Catch up" again after reset to continue replying to old comments.</div>` : ''}

  <div class="stats-row">
    <div class="stat-box"><div class="stat-label">Replies posted</div><div class="stat-value" style="color:#22c55e">${stats.totalReplied.toLocaleString()}</div><div class="stat-sub">all time</div></div>
    <div class="stat-box"><div class="stat-label">Unreplied</div><div class="stat-value" style="color:${(stats.unrepliedCount||0)>0?'#ef4444':'#22c55e'}">${stats.unrepliedCount !== null ? stats.unrepliedCount : '—'}</div><div class="stat-sub">pending replies</div></div>
    <div class="stat-box"><div class="stat-label">Quota used today</div><div class="stat-value" style="color:${quotaPct>=autoPauseAt?'#ef4444':'#f59e0b'}">${stats.quotaUsed.toLocaleString()}</div><div class="stat-sub">of ${DAILY_QUOTA_UNITS.toLocaleString()} units</div></div>
    <div class="stat-box"><div class="stat-label">Quota resets in</div><div class="stat-value" style="color:#f59e0b;font-size:22px">${timeUntilReset()}</div><div class="stat-sub">midnight PT</div></div>
  </div>

  <div class="two-col">
    <div class="panel">
      <div class="panel-title">Quota Usage</div>
      <div style="margin-bottom:12px">
        <div class="qbar-label"><span style="color:#9ca3af">${stats.quotaUsed.toLocaleString()} / ${DAILY_QUOTA_UNITS.toLocaleString()} units</span><span style="color:${quotaColor};font-weight:600">${quotaPct}%</span></div>
        <div class="qbar"><div class="qbar-fill"></div></div>
      </div>
      <div class="qs">
        <div class="qb"><div class="qb-val">~50</div><div class="qb-lbl">Reading units</div></div>
        <div class="qb"><div class="qb-val">${REPLY_COST_UNITS}</div><div class="qb-lbl">Per reply</div></div>
        <div class="qb"><div class="qb-val" style="color:${remaining>10?'#22c55e':'#ef4444'}">${remaining}</div><div class="qb-lbl">Left today</div></div>
      </div>
      <div class="quota-tip">✦ <a href="https://console.cloud.google.com/apis/api/youtube.googleapis.com/quotas" target="_blank" style="color:#60a5fa">Apply for quota increase</a> in Google Cloud → Free increases up to 1M units/day.</div>
    </div>

    <div class="panel">
      <div class="panel-title">Check Interval</div>
      <div class="ibtnrow">
        <a href="/bot/interval/15"    class="ibtn ${checkIntervalMins===15?'active':''}">Every 15 min</a>
        <a href="/bot/interval/60"    class="ibtn ${checkIntervalMins===60?'active':''}">Every hour</a>
        <a href="/bot/interval/360"   class="ibtn ${checkIntervalMins===360?'active':''}">Every 6 hours</a>
        <a href="/bot/interval/1440"  class="ibtn ${checkIntervalMins===1440?'active':''}">Daily</a>
        <a href="/bot/interval/10080" class="ibtn ${checkIntervalMins===10080?'active':''}">Weekly</a>
        <a href="/bot/interval/43200" class="ibtn ${checkIntervalMins===43200?'active':''}">Monthly</a>
      </div>
      <div class="ihint">Checking every <strong>${fmtInterval(checkIntervalMins)}</strong> — ${Math.round(1440/checkIntervalMins)} checks/day.</div>
      <div class="panel-title">Quota Auto-Pause</div>
      <div class="ap-row"><div class="ap-lbl">Pause when quota reaches</div><div class="ap-val">${autoPauseAt}%</div></div>
      <div class="ap-sub">Pauses at ${Math.round(DAILY_QUOTA_UNITS * autoPauseAt / 100).toLocaleString()} units</div>
      <div class="apbtns">${[70,80,90,95].map(p=>`<a href="/bot/autopause/${p}" class="ibtn ${autoPauseAt===p?'active':''}" style="padding:5px 10px;font-size:11px">${p}%</a>`).join('')}</div>
    </div>
  </div>

  <!-- Catch-up section -->
  <div class="catch-box">
    <div class="panel-title">🔄 Catch Up Old Comments</div>
    <div class="catch-box-note">
      ✅ <strong>Fixed!</strong> The bot now scans ALL comments including old ones from last year. It checks if YOU specifically replied (not just if anyone replied). Old comments are replied to first (oldest → newest).
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:${stats.catchupTotal>0?'12px':'0'}">
      ${!catchingUp && !isQuotaExhausted() ? `<a href="/bot/catchup" class="hbtn hbtn-primary">🔄 Catch up old comments (${remaining} left today)</a>` : ''}
      ${isQuotaExhausted() ? `<span class="hbtn" style="opacity:.5;cursor:not-allowed">⏳ Come back in ${timeUntilReset()}</span>` : ''}
      ${catchingUp ? `<span class="hbtn" style="opacity:.5;cursor:not-allowed">⏳ Catching up… ${stats.catchupDone}/${stats.catchupTotal}</span>` : ''}
      ${connected ? `<a href="/bot/scan" class="hbtn">⟳ Scan now</a>` : ''}
    </div>
    ${stats.catchupTotal > 0 ? `
    <div class="pbar"><div class="pbar-fill" style="width:${catchupPct}%"></div></div>
    <div class="pbar-info"><span>${stats.catchupDone} / ${stats.catchupTotal} replied</span><span>${catchupPct}%</span></div>` : ''}
  </div>

  <!-- Activity Log -->
  <div class="log-panel">
    <div class="panel-title" style="margin-bottom:14px">Activity Log</div>
    <ul class="log-list">
      ${logs.length === 0 ? '<li style="padding:16px 0;text-align:center;color:#4b5563;font-size:12px">No activity yet…</li>' : ''}
      ${logs.map(l => `<li class="log-item">
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

function esc(s) { return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }

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
    channelOwnerId = null;
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
    const comments = await scanRecentComments(auth, channelId);
    stats.unrepliedCount = comments.length;
    log(`Scan complete — ${comments.length} unreplied recent comments`, 'success');
  } catch(e) { log('Scan error: ' + e.message, 'error'); }
});
app.get('/bot/interval/:mins', (req, res) => {
  const mins = parseInt(req.params.mins);
  if ([15,60,360,1440,10080,43200].includes(mins)) setIntervalMins(mins);
  res.redirect('/');
});
app.get('/bot/autopause/:pct', (req, res) => {
  const pct = parseInt(req.params.pct);
  if ([70,80,90,95].includes(pct)) { autoPauseAt = pct; log(`Auto-pause set to ${pct}%`, 'success'); }
  res.redirect('/');
});
app.get('/debug', (req, res) => res.json({ connected: !!refreshToken, botRunning, catchingUp, checkIntervalMins, autoPauseAt, channelOwnerId, stats }));

app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, 'success');
  if (refreshToken) { log('Starting bot automatically', 'success'); startBot(); }
});
