require('dotenv').config();
const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');
 
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
 
// ── Config ────────────────────────────────────────────────────────────────────
const CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const CLAUDE_KEY    = process.env.ANTHROPIC_API_KEY;
const REPLY_TONE    = process.env.REPLY_TONE    || 'friendly and warm';
const REPLY_LENGTH  = process.env.REPLY_LENGTH  || 'short (1-2 sentences)';
const CHANNEL_NAME  = process.env.CHANNEL_NAME  || '';
const PORT          = process.env.PORT          || 8080;
const CHECK_INTERVAL_MINS = parseInt(process.env.CHECK_INTERVAL_MINS || '15');
const REDIRECT_URI  = process.env.REDIRECT_URI  || `http://localhost:${PORT}/auth/callback`;
 
// ── State ─────────────────────────────────────────────────────────────────────
let refreshToken  = process.env.GOOGLE_REFRESH_TOKEN || null;
let botRunning    = false;
let botInterval   = null;
let logs          = [];
let stats         = { checked: 0, replied: 0, errors: 0, lastRun: null };
let repliedIds    = new Set();
 
function log(msg, type = 'info') {
  const entry = { time: new Date().toISOString(), msg, type };
  logs.unshift(entry);
  if (logs.length > 200) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}
 
// ── OAuth ─────────────────────────────────────────────────────────────────────
function getOAuth2Client() {
  return new google.auth.OAuth2(CLIENT_ID, CLIENT_SECRET, REDIRECT_URI);
}
 
async function getAuthenticatedClient() {
  if (!refreshToken) throw new Error('Not authenticated. Visit /auth to connect YouTube.');
  const oauth2 = getOAuth2Client();
  oauth2.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await oauth2.refreshAccessToken();
  oauth2.setCredentials(credentials);
  return oauth2;
}
 
// ── YouTube helpers ───────────────────────────────────────────────────────────
async function getChannelId(auth) {
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.channels.list({ part: 'id', mine: true });
  return res.data.items[0].id;
}
 
async function getUnrepliedComments(auth, channelId, maxResults = 50) {
  const yt = google.youtube({ version: 'v3', auth });
  const res = await yt.commentThreads.list({
    part: 'snippet',
    allThreadsRelatedToChannelId: channelId,
    maxResults,
    order: 'time',
    moderationStatus: 'published'
  });
 
  const items = res.data.items || [];
  return items.filter(t => {
    const s = t.snippet.topLevelComment.snippet;
    const id = t.snippet.topLevelComment.id;
    const alreadyReplied = t.snippet.totalReplyCount > 0;
    const isOwn = s.authorIsChannelOwner;
    return !isOwn && !alreadyReplied && !repliedIds.has(id);
  });
}
 
async function postReply(auth, parentId, text) {
  const yt = google.youtube({ version: 'v3', auth });
  await yt.comments.insert({
    part: 'snippet',
    requestBody: { snippet: { parentId, textOriginal: text } }
  });
}
 
// ── Claude ────────────────────────────────────────────────────────────────────
async function generateReply(commentText) {
  const system = `You are a YouTube creator${CHANNEL_NAME ? ` named "${CHANNEL_NAME}"` : ''}. Reply to a YouTube comment in a ${REPLY_TONE} tone. Keep it ${REPLY_LENGTH}. Be authentic — no hollow phrases like "Great question!". Return ONLY the reply text, nothing else.`;
 
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 150,
      system,
      messages: [{ role: 'user', content: commentText }]
    })
  });
 
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.content[0].text.trim();
}
 
// ── Bot loop ──────────────────────────────────────────────────────────────────
async function runBotCycle() {
  if (!refreshToken) { log('No YouTube auth — skipping cycle', 'warn'); return; }
  log('Starting check cycle…');
  stats.lastRun = new Date().toISOString();
 
  try {
    const auth = await getAuthenticatedClient();
    const channelId = await getChannelId(auth);
    const threads = await getUnrepliedComments(auth, channelId);
    stats.checked += threads.length;
    log(`Found ${threads.length} unreplied comment(s)`);
 
    for (const thread of threads) {
      const s = thread.snippet.topLevelComment.snippet;
      const id = thread.snippet.topLevelComment.id;
      try {
        const reply = await generateReply(s.textDisplay);
        await postReply(auth, id, reply);
        repliedIds.add(id);
        stats.replied++;
        log(`Replied to ${s.authorDisplayName}: "${s.textDisplay.slice(0, 60)}…"`, 'success');
        await sleep(1500);
      } catch (e) {
        stats.errors++;
        log(`Failed to reply to comment ${id}: ${e.message}`, 'error');
      }
    }
    log('Cycle complete ✓', 'success');
  } catch (e) {
    stats.errors++;
    log(`Cycle error: ${e.message}`, 'error');
  }
}
 
function startBot() {
  if (botRunning) return;
  botRunning = true;
  log(`Bot started — checking every ${CHECK_INTERVAL_MINS} minutes`, 'success');
  runBotCycle();
  botInterval = setInterval(runBotCycle, CHECK_INTERVAL_MINS * 60 * 1000);
}
 
function stopBot() {
  if (!botRunning) return;
  clearInterval(botInterval);
  botRunning = false;
  log('Bot stopped', 'warn');
}
 
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
 
// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  const connected = !!refreshToken;
  const statusColor = botRunning ? '#2ecc71' : connected ? '#f0a500' : '#e74c3c';
  const statusText  = botRunning ? 'Running' : connected ? 'Paused' : 'Not connected';
 
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AlvinHub AI Reply Bot</title>
<meta http-equiv="refresh" content="30">
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0f0f0f;color:#f1f1f1;min-height:100vh}
header{display:flex;align-items:center;gap:12px;padding:16px 24px;background:#1a1a1a;border-bottom:1px solid rgba(255,255,255,0.1)}
.logo{display:flex;align-items:center;gap:10px;font-size:18px;font-weight:600}
.badge{font-size:11px;background:#ff0000;color:#fff;padding:2px 7px;border-radius:4px}
.dot{width:10px;height:10px;border-radius:50%;background:${statusColor};margin-left:auto}
main{max-width:800px;margin:0 auto;padding:32px 20px}
.card{background:#1a1a1a;border:1px solid rgba(255,255,255,0.1);border-radius:12px;padding:24px;margin-bottom:20px}
.card h2{font-size:15px;font-weight:600;margin-bottom:16px;color:#aaa;text-transform:uppercase;letter-spacing:.05em}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:12px}
.stat{background:#242424;border-radius:8px;padding:16px;text-align:center}
.stat-num{font-size:28px;font-weight:700}
.stat-lbl{font-size:11px;color:#666;margin-top:4px}
.status-badge{display:inline-flex;align-items:center;gap:8px;padding:6px 14px;border-radius:20px;font-size:13px;font-weight:500;background:${statusColor}22;color:${statusColor};border:1px solid ${statusColor}44;margin-bottom:16px}
.btn{display:inline-flex;align-items:center;gap:8px;padding:10px 20px;border-radius:8px;font-size:14px;font-weight:500;cursor:pointer;border:none;text-decoration:none;transition:opacity .15s}
.btn-red{background:#ff0000;color:#fff}
.btn-green{background:#2ecc71;color:#fff}
.btn-gray{background:#333;color:#f1f1f1}
.btn:hover{opacity:.85}
.btn-row{display:flex;gap:10px;flex-wrap:wrap}
.log-list{list-style:none;max-height:320px;overflow-y:auto}
.log-list li{padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.06);font-size:12px;display:flex;gap:10px}
.log-time{color:#555;flex-shrink:0}
.log-msg{color:#ccc}
.log-success .log-msg{color:#2ecc71}
.log-error .log-msg{color:#e74c3c}
.log-warn .log-msg{color:#f0a500}
.setup-note{font-size:13px;color:#aaa;line-height:1.6}
.setup-note a{color:#4a9eff}
.setup-note code{background:#242424;padding:2px 6px;border-radius:4px;font-size:12px}
</style>
</head>
<body>
<header>
  <div class="logo">
    <svg width="28" height="20" viewBox="0 0 90 63"><rect width="90" height="63" rx="14" fill="#FF0000"/><path d="M37 20l24 11.5L37 43V20z" fill="white"/></svg>
    AlvinHub AI Reply Bot
    <span class="badge">AI</span>
  </div>
  <div class="dot" title="${statusText}"></div>
</header>
 
<main>
  <div class="card">
    <h2>Bot Status</h2>
    <div class="status-badge">● ${statusText}</div>
    <div class="stats">
      <div class="stat"><div class="stat-num">${stats.checked}</div><div class="stat-lbl">Comments checked</div></div>
      <div class="stat"><div class="stat-num" style="color:#2ecc71">${stats.replied}</div><div class="stat-lbl">Replies posted</div></div>
      <div class="stat"><div class="stat-num" style="color:#e74c3c">${stats.errors}</div><div class="stat-lbl">Errors</div></div>
      <div class="stat"><div class="stat-num" style="font-size:14px;padding-top:6px">${stats.lastRun ? new Date(stats.lastRun).toLocaleTimeString() : '—'}</div><div class="stat-lbl">Last check</div></div>
    </div>
    <div class="btn-row" style="margin-top:20px">
      ${!connected ? `<a href="/auth" class="btn btn-red">Connect YouTube</a>` : ''}
      ${connected && !botRunning ? `<a href="/bot/start" class="btn btn-green">▶ Start bot</a>` : ''}
      ${botRunning ? `<a href="/bot/stop" class="btn btn-gray">⏹ Stop bot</a>` : ''}
      ${connected ? `<a href="/bot/run-now" class="btn btn-gray">⚡ Run now</a>` : ''}
    </div>
  </div>
 
  ${!connected ? `
  <div class="card">
    <h2>Setup required</h2>
    <p class="setup-note">
      Click <strong>Connect YouTube</strong> above to link your YouTube channel.<br><br>
      Make sure your environment variables are set:<br>
      <code>GOOGLE_CLIENT_ID</code>, <code>GOOGLE_CLIENT_SECRET</code>, <code>ANTHROPIC_API_KEY</code><br><br>
      And add <code>${REDIRECT_URI}</code> to your Google OAuth <strong>Authorised redirect URIs</strong>.
    </p>
  </div>` : ''}
 
  <div class="card">
    <h2>Activity log</h2>
    <ul class="log-list">
      ${logs.length === 0 ? '<li><span class="log-msg" style="color:#555">No activity yet…</span></li>' : ''}
      ${logs.map(l => `
        <li class="log-${l.type}">
          <span class="log-time">${new Date(l.time).toLocaleTimeString()}</span>
          <span class="log-msg">${l.msg}</span>
        </li>`).join('')}
    </ul>
  </div>
</main>
</body></html>`);
});
 
// Debug route
app.get('/debug', (req, res) => {
  res.json({
    hasClientId: !!process.env.GOOGLE_CLIENT_ID,
    hasClientSecret: !!process.env.GOOGLE_CLIENT_SECRET,
    hasClaudeKey: !!process.env.ANTHROPIC_API_KEY,
    redirectUri: process.env.REDIRECT_URI || 'NOT SET',
    clientIdPreview: (process.env.GOOGLE_CLIENT_ID || 'NOT SET').slice(0, 25) + '...'
  });
});
 
// Auth routes
app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.REDIRECT_URI;
  if (!clientId) return res.send('Error: GOOGLE_CLIENT_ID not set in Railway variables.');
  const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/youtube.force-ssl']
  });
  res.redirect(url);
});
 
app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;
  if (!code) return res.send('Error: no code received');
  try {
    const clientId = process.env.GOOGLE_CLIENT_ID;
    const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
    const redirectUri = process.env.REDIRECT_URI;
    const oauth2 = new google.auth.OAuth2(clientId, clientSecret, redirectUri);
    const { tokens } = await oauth2.getToken(code);
    refreshToken = tokens.refresh_token;
    log('YouTube account connected successfully!', 'success');
    res.redirect('/');
  } catch (e) {
    log('Auth error: ' + e.message, 'error');
    res.send('Auth error: ' + e.message);
  }
});
 
// Bot control routes
app.get('/bot/start', (req, res) => { startBot(); res.redirect('/'); });
app.get('/bot/stop',  (req, res) => { stopBot();  res.redirect('/'); });
app.get('/bot/run-now', async (req, res) => {
  res.redirect('/');
  await runBotCycle();
});
 
// ── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  log(`Server running on port ${PORT}`, 'success');
  if (refreshToken) { log('Refresh token found — starting bot automatically', 'success'); startBot(); }
});
