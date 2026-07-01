require('dotenv').config();

const express = require('express');
const { google } = require('googleapis');
const fetch = require('node-fetch');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const CLAUDE_KEY = process.env.ANTHROPIC_API_KEY;
const REPLY_TONE = process.env.REPLY_TONE || 'friendly, warm and natural';
const REPLY_LENGTH = process.env.REPLY_LENGTH || 'short, 1 sentence';
const CHANNEL_NAME = process.env.CHANNEL_NAME || 'AlvinHub';
const PORT = process.env.PORT || 8080;

const DAILY_QUOTA = 10000;
const REPLY_COST = 50;
const SCAN_COST = 1;
const SEARCH_COST = 100;

const DATA_DIR = path.join(__dirname, 'data');
const STATE_FILE = path.join(DATA_DIR, 'reply-state.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

let refreshToken = process.env.YOUTUBE_REFRESH_TOKEN || null;
let botRunning = false;
let botInterval = null;
let catchingUp = false;
let checkIntervalMins = Number(process.env.CHECK_INTERVAL_MINS || 15);
let autoPauseAt = Number(process.env.AUTO_PAUSE_AT || 90);
let logs = [];
let scannedComments = [];
let videoList = [];

let state = loadState();

let repliedCommentIds = new Set(state.repliedCommentIds || []);
let closedThreadIds = new Set(state.closedThreadIds || []);
let skippedCommentIds = new Set(state.skippedCommentIds || []);
let replyHistory = state.replyHistory || [];
let duplicateTexts = state.duplicateTexts || {};

let stats = {
  totalReplied: state.totalReplied || 0,
  totalSkipped: state.totalSkipped || 0,
  quotaUsed: 0,
  dailyResetAt: getNextResetTime(),
  lastRun: null,
  catchupDone: 0,
  catchupTotal: 0,
};

const TIME_FILTERS = {
  all: { label: 'All time', ms: null },
  '5min': { label: 'Last 5 minutes', ms: 5 * 60 * 1000 },
  '10min': { label: 'Last 10 minutes', ms: 10 * 60 * 1000 },
  '30min': { label: 'Last 30 minutes', ms: 30 * 60 * 1000 },
  '1hour': { label: 'Last 1 hour', ms: 60 * 60 * 1000 },
  '5days': { label: 'Last 5 days', ms: 5 * 86400000 },
  week: { label: 'Last 1 week', ms: 7 * 86400000 },
  month: { label: 'Last 1 month', ms: 30 * 86400000 },
  '2months': { label: 'Last 2 months', ms: 60 * 86400000 },
  '3months': { label: 'Last 3 months', ms: 90 * 86400000 },
  '6months': { label: 'Last 6 months', ms: 180 * 86400000 },
  year: { label: 'Last 1 year', ms: 365 * 86400000 },
  '2years': { label: 'Last 2 years', ms: 730 * 86400000 },
};

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return {};
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch (e) {
    console.error('Could not load state:', e.message);
    return {};
  }
}

function saveState() {
  const payload = {
    repliedCommentIds: Array.from(repliedCommentIds).slice(-50000),
    closedThreadIds: Array.from(closedThreadIds).slice(-50000),
    skippedCommentIds: Array.from(skippedCommentIds).slice(-50000),
    replyHistory: replyHistory.slice(0, 1000),
    duplicateTexts,
    totalReplied: stats.totalReplied,
    totalSkipped: stats.totalSkipped,
    savedAt: new Date().toISOString(),
  };

  fs.writeFileSync(STATE_FILE, JSON.stringify(payload, null, 2));
}

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
    log('Daily quota reset.', 'success');
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
  return stats.quotaUsed >= DAILY_QUOTA * (autoPauseAt / 100);
}

function repliesLeft() {
  return Math.max(0, Math.floor((DAILY_QUOTA - stats.quotaUsed) / REPLY_COST));
}

function log(msg, type = 'info', badge = null) {
  logs.unshift({ time: new Date().toISOString(), msg, type, badge });
  if (logs.length > 400) logs.pop();
  console.log(`[${type.toUpperCase()}] ${msg}`);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normaliseText(text) {
  return stripHtml(text)
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9\s]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getRedirectUri() {
  return process.env.REDIRECT_URI || `http://localhost:${PORT}/auth/callback`;
}

function getAge(date) {
  const diff = Date.now() - new Date(date).getTime();
  const mins = Math.floor(diff / 60000);
  const days = Math.floor(diff / 86400000);

  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  if (days === 0) return `${Math.floor(mins / 60)}h ago`;
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${Math.floor(days / 7)}w ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function fmtInterval(m) {
  return {
    5: '5 min',
    15: '15 min',
    30: '30 min',
    60: '1 hour',
    360: '6 hours',
    1440: 'daily',
    10080: 'weekly',
  }[m] || `${m} min`;
}

function withinTimeFilter(date, filter) {
  if (!filter || filter === 'all') return true;
  const f = TIME_FILTERS[filter];
  if (!f || !f.ms) return true;
  return new Date(date).getTime() >= Date.now() - f.ms;
}

function isDuplicateReplyComplaint(text) {
  const clean = normaliseText(text);
  return /(same comment|same reply|copy pasted|copy paste|copy and paste|keeps replying|replying again|already replied|multiple replies|repeated reply|repeating|bot|spam|stop replying|you replied already|why are you replying)/i.test(clean);
}

function shouldSkipByTextPattern(text) {
  const clean = normaliseText(text);

  if (!clean) return { skip: true, reason: 'empty comment' };

  if (isDuplicateReplyComplaint(clean)) {
    return { skip: true, reason: 'viewer complained about repeated replies' };
  }

  duplicateTexts[clean] = duplicateTexts[clean] || 0;
  duplicateTexts[clean]++;

  if (duplicateTexts[clean] >= 3) {
    return { skip: true, reason: 'same comment text repeated multiple times' };
  }

  return { skip: false, reason: '' };
}

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
    oauth2.setCredentials({ ...credentials, refresh_token: refreshToken });
    return oauth2;
  } catch (e) {
    if (
      String(e.message).includes('invalid_grant') ||
      String(e.message).includes('Token has been expired')
    ) {
      log('Session expired — reconnect YouTube.', 'error');
      stopBot();
      throw new Error('SESSION_EXPIRED');
    }

    throw e;
  }
}

async function getChannelId(auth) {
  const yt = google.youtube({ version: 'v3', auth });
  stats.quotaUsed += SCAN_COST;

  const res = await yt.channels.list({
    part: 'id,snippet',
    mine: true,
  });

  const item = res.data.items?.[0];
  if (!item) throw new Error('Could not find YouTube channel.');

  return item.id;
}

async function hasChannelAlreadyRepliedInThread(auth, parentCommentId, channelId) {
  const yt = google.youtube({ version: 'v3', auth });
  let pageToken = null;

  do {
    const params = {
      part: 'snippet',
      parentId: parentCommentId,
      maxResults: 100,
    };

    if (pageToken) params.pageToken = pageToken;

    stats.quotaUsed += SCAN_COST;
    const res = await yt.comments.list(params);
    const replies = res.data.items || [];

    const found = replies.some(reply => {
      const s = reply.snippet || {};
      return (
        s.authorChannelId?.value === channelId ||
        String(s.authorDisplayName || '').toLowerCase() === CHANNEL_NAME.toLowerCase()
      );
    });

    if (found) return true;

    pageToken = res.data.nextPageToken;
  } while (pageToken && !isQuotaExhausted());

  return false;
}

async function fetchChannelVideos(auth, channelId) {
  const yt = google.youtube({ version: 'v3', auth });
  let videos = [];
  let pageToken = null;

  while (videos.length < 200 && !isQuotaExhausted()) {
    const params = {
      part: 'snippet',
      channelId,
      maxResults: 50,
      order: 'date',
      type: 'video',
    };

    if (pageToken) params.pageToken = pageToken;

    stats.quotaUsed += SEARCH_COST;
    const res = await yt.search.list(params);

    for (const v of res.data.items || []) {
      if (!v.id?.videoId) continue;

      videos.push({
        id: v.id.videoId,
        title: v.snippet.title,
        thumbnail: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        publishedAt: v.snippet.publishedAt,
        url: `https://youtube.com/watch?v=${v.id.videoId}`,
      });
    }

    pageToken = res.data.nextPageToken;
    if (!pageToken) break;

    await sleep(200);
  }

  return videos;
}

async function scanComments(auth, channelId, options = {}) {
  const { videoId, dateFilter = 'all', maxPages = 10 } = options;
  const yt = google.youtube({ version: 'v3', auth });

  let all = [];
  let pageToken = null;
  let pages = 0;

  while (pages < maxPages && !isQuotaExhausted()) {
    const params = {
      part: 'snippet,replies',
      maxResults: 100,
      moderationStatus: 'published',
      order: 'time',
    };

    if (videoId) params.videoId = videoId;
    else params.allThreadsRelatedToChannelId = channelId;

    if (pageToken) params.pageToken = pageToken;

    stats.quotaUsed += SCAN_COST;

    try {
      const res = await yt.commentThreads.list(params);
      const items = res.data.items || [];

      for (const thread of items) {
        const top = thread.snippet.topLevelComment;
        const s = top.snippet;

        const commentId = top.id;
        const threadId = thread.id;
        const publishedAt = new Date(s.publishedAt);
        const updatedAt = new Date(s.updatedAt || s.publishedAt);

        if (s.authorIsChannelOwner) continue;
        if (!withinTimeFilter(publishedAt, dateFilter)) continue;

        if (repliedCommentIds.has(commentId)) continue;
        if (closedThreadIds.has(threadId) || closedThreadIds.has(commentId)) continue;
        if (skippedCommentIds.has(commentId)) continue;

        const inlineReplies = thread.replies?.comments || [];
        const channelReplyInline = inlineReplies.some(reply => {
          const rs = reply.snippet || {};
          return (
            rs.authorChannelId?.value === channelId ||
            String(rs.authorDisplayName || '').toLowerCase() === CHANNEL_NAME.toLowerCase()
          );
        });

        if (channelReplyInline) {
          repliedCommentIds.add(commentId);
          closedThreadIds.add(threadId);
          closedThreadIds.add(commentId);
          continue;
        }

        const alreadyReplied = await hasChannelAlreadyRepliedInThread(auth, commentId, channelId);

        if (alreadyReplied) {
          repliedCommentIds.add(commentId);
          closedThreadIds.add(threadId);
          closedThreadIds.add(commentId);
          continue;
        }

        const textCheck = shouldSkipByTextPattern(s.textDisplay);

        if (textCheck.skip) {
          skippedCommentIds.add(commentId);
          stats.totalSkipped++;
          log(`Skipped ${s.authorDisplayName}: ${textCheck.reason}`, 'warn');
          continue;
        }

        all.push({
          id: commentId,
          threadId,
          videoId: thread.snippet.videoId,
          author: s.authorDisplayName,
          authorImg: s.authorProfileImageUrl || '',
          text: s.textDisplay,
          cleanText: stripHtml(s.textDisplay),
          likeCount: s.likeCount || 0,
          publishedAt,
          updatedAt,
          replied: false,
          skipped: false,
          status: 'unreplied',
        });
      }

      pages++;
      pageToken = res.data.nextPageToken;

      if (!pageToken) break;

      await sleep(150);
    } catch (e) {
      if (String(e.message).toLowerCase().includes('quota')) throw e;
      log(`Comment scan stopped: ${e.message}`, 'warn');
      break;
    }
  }

  all.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
  saveState();

  return all;
}

async function generateReply(commentText) {
  if (!CLAUDE_KEY) throw new Error('ANTHROPIC_API_KEY is not set.');

  const system = `You are a YouTube creator named "${CHANNEL_NAME}". Reply to this YouTube comment in a ${REPLY_TONE} tone. Keep it ${REPLY_LENGTH}. Do not sound robotic. Do not repeat the viewer's full comment. Do not apologise unless the viewer directly complains. Return ONLY the reply text.`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-5',
      max_tokens: 150,
      system,
      messages: [
        {
          role: 'user',
          content: stripHtml(commentText),
        },
      ],
    }),
  });

  const data = await res.json();

  if (data.error) throw new Error(data.error.message);

  return data.content?.[0]?.text?.trim() || '';
}

async function postReply(auth, parentId, text) {
  const yt = google.youtube({ version: 'v3', auth });

  stats.quotaUsed += REPLY_COST;

  await yt.comments.insert({
    part: 'snippet',
    requestBody: {
      snippet: {
        parentId,
        textOriginal: text,
      },
    },
  });
}

async function replyToComment(auth, channelId, comment) {
  if (
    repliedCommentIds.has(comment.id) ||
    closedThreadIds.has(comment.threadId) ||
    closedThreadIds.has(comment.id)
  ) {
    return { replied: false, reason: 'already handled locally' };
  }

  const alreadyReplied = await hasChannelAlreadyRepliedInThread(auth, comment.id, channelId);

  if (alreadyReplied) {
    repliedCommentIds.add(comment.id);
    closedThreadIds.add(comment.threadId);
    closedThreadIds.add(comment.id);
    saveState();
    return { replied: false, reason: 'already replied on YouTube' };
  }

  const textCheck = shouldSkipByTextPattern(comment.text);

  if (textCheck.skip) {
    skippedCommentIds.add(comment.id);
    stats.totalSkipped++;
    saveState();
    return { replied: false, reason: textCheck.reason };
  }

  const reply = await generateReply(comment.text);

  if (!reply) return { replied: false, reason: 'empty generated reply' };

  await postReply(auth, comment.id, reply);

  repliedCommentIds.add(comment.id);
  closedThreadIds.add(comment.threadId);
  closedThreadIds.add(comment.id);

  comment.replied = true;
  comment.status = 'replied';

  stats.totalReplied++;

  replyHistory.unshift({
    time: new Date().toISOString(),
    commentId: comment.id,
    threadId: comment.threadId,
    videoId: comment.videoId,
    author: comment.author,
    comment: stripHtml(comment.text).slice(0, 500),
    reply,
    publishedAt: comment.publishedAt,
  });

  if (replyHistory.length > 1000) replyHistory.pop();

  saveState();

  return { replied: true, reply };
}

async function runBotCycle(dateFilter = 'all') {
  if (!refreshToken) {
    log('Not connected — visit /auth', 'warn');
    return;
  }

  checkDailyReset();

  if (isQuotaExhausted()) {
    log(`Quota at ${autoPauseAt}% — resets in ${timeUntilReset()}`, 'warn');
    return;
  }

  stats.lastRun = new Date().toISOString();

  const label = TIME_FILTERS[dateFilter]?.label || 'All time';
  log(`Checking latest unreplied comments: ${label}`);

  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);

    const comments = await scanComments(auth, channelId, {
      dateFilter,
      maxPages: 3,
    });

    scannedComments = comments;

    log(`Found ${comments.length} safe unreplied comments.`, comments.length ? 'success' : 'info');

    let replied = 0;

    for (const comment of comments) {
      if (isQuotaExhausted()) {
        log('Quota limit reached — pausing.', 'warn');
        break;
      }

      try {
        const result = await replyToComment(auth, channelId, comment);

        if (result.replied) {
          replied++;
          log(`Replied to ${comment.author} (${getAge(comment.publishedAt)})`, 'success', `+${REPLY_COST}`);
        } else {
          log(`Skipped ${comment.author}: ${result.reason}`, 'warn');
        }

        await sleep(1500);
      } catch (e) {
        if (e.message === 'SESSION_EXPIRED') return;
        if (String(e.message).toLowerCase().includes('quota')) {
          log('Quota hit.', 'warn');
          break;
        }

        log(`Reply failed: ${e.message}`, 'error');
      }
    }

    log(
      replied > 0 ? `Cycle complete — replied to ${replied} comments.` : 'Cycle complete — no new comments.',
      'success'
    );
  } catch (e) {
    if (e.message === 'SESSION_EXPIRED') return;
    log(`Cycle error: ${e.message}`, 'error');
  }
}

async function runCatchUp(options = {}) {
  if (catchingUp || !refreshToken) return;

  checkDailyReset();

  if (isQuotaExhausted()) {
    log(`Quota exhausted — resets in ${timeUntilReset()}`, 'warn');
    return;
  }

  const canReply = repliesLeft();

  if (canReply <= 0) return;

  catchingUp = true;

  const dateFilter = options.dateFilter || 'all';
  const filterLabel = TIME_FILTERS[dateFilter]?.label || 'All time';
  const videoLabel = options.videoId ? `video ${options.videoId}` : 'all videos';

  log(`Catch-up started — ${videoLabel}, ${filterLabel}.`, 'success');

  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);

    const comments = await scanComments(auth, channelId, {
      videoId: options.videoId || null,
      dateFilter,
      maxPages: Number(options.maxPages || 15),
    });

    scannedComments = comments;

    stats.catchupTotal = Math.min(comments.length, canReply);
    stats.catchupDone = 0;

    log(`Found ${comments.length} safe unreplied comments.`, 'success');

    for (const comment of comments.slice(0, canReply)) {
      if (isQuotaExhausted()) {
        log(`Limit reached after ${stats.catchupDone}. Resets in ${timeUntilReset()}.`, 'warn');
        break;
      }

      try {
        const result = await replyToComment(auth, channelId, comment);
        stats.catchupDone++;

        if (result.replied) {
          log(`[${stats.catchupDone}/${stats.catchupTotal}] Replied to ${comment.author}.`, 'success', `+${REPLY_COST}`);
        } else {
          log(`[${stats.catchupDone}/${stats.catchupTotal}] Skipped ${comment.author}: ${result.reason}`, 'warn');
        }

        await sleep(1500);
      } catch (e) {
        if (e.message === 'SESSION_EXPIRED') {
          catchingUp = false;
          return;
        }

        if (String(e.message).toLowerCase().includes('quota')) {
          log(`Quota hit after ${stats.catchupDone} comments.`, 'warn');
          break;
        }

        stats.catchupDone++;
        log(`Failed: ${e.message}`, 'error');
      }
    }

    log(`Catch-up done — processed ${stats.catchupDone} comments.`, 'success');
  } catch (e) {
    if (e.message !== 'SESSION_EXPIRED') {
      log(`Catch-up error: ${e.message}`, 'error');
    }
  }

  catchingUp = false;
}

function startBot() {
  if (botRunning) return;

  botRunning = true;
  log(`Bot started — checking every ${fmtInterval(checkIntervalMins)}.`, 'success');

  runBotCycle('all');

  botInterval = setInterval(() => {
    runBotCycle('all');
  }, checkIntervalMins * 60 * 1000);
}

function stopBot() {
  if (!botRunning) return;

  clearInterval(botInterval);
  botRunning = false;
  log('Bot stopped.', 'warn');
}

function setIntervalMins(mins) {
  checkIntervalMins = mins;

  if (botRunning) {
    clearInterval(botInterval);
    botInterval = setInterval(() => {
      runBotCycle('all');
    }, mins * 60 * 1000);
  }

  log(`Interval changed to ${fmtInterval(mins)}.`, 'success');
}

function renderFilterButtons() {
  return Object.entries(TIME_FILTERS)
    .map(([key, filter]) => {
      return `<a class="btn" href="/bot/catchup?filter=${key}">${esc(filter.label)}</a>`;
    })
    .join('');
}

function renderFilterTabs(activeFilter) {
  return Object.entries(TIME_FILTERS)
    .map(([key, filter]) => {
      return `<a class="tab ${activeFilter === key ? 'active' : ''}" href="/?page=comments&filter=${key}">${esc(filter.label)}</a>`;
    })
    .join('');
}

function renderComments(filter = 'all') {
  let comments = scannedComments;

  if (filter && filter !== 'all') {
    comments = comments.filter(comment => withinTimeFilter(comment.publishedAt, filter));
  }

  if (!comments.length) {
    return `<div class="empty">No comments in this filter. Click Scan Comments first.</div>`;
  }

  return comments
    .slice(0, 80)
    .map(comment => {
      const status = comment.replied ? 'Replied' : comment.skipped ? 'Skipped' : 'Unreplied';
      const statusClass = comment.replied ? 'good' : comment.skipped ? 'bad' : 'warn';

      return `
        <div class="comment">
          <div class="comment-top">
            <img class="avatar" src="${esc(comment.authorImg)}" onerror="this.style.display='none'">
            <div>
              <div class="author">${esc(comment.author)}</div>
              <div class="time">${getAge(comment.publishedAt)} · ${new Date(comment.publishedAt).toLocaleString('en-GB')}</div>
            </div>
            <span class="status ${statusClass}">${status}</span>
          </div>

          <div class="comment-text">${esc(stripHtml(comment.text))}</div>

          <div class="actions">
            ${
              !comment.replied && !comment.skipped
                ? `<a class="btn small blue" href="/reply-one/${encodeURIComponent(comment.id)}?page=comments&filter=${esc(filter)}">Reply</a>`
                : ''
            }
            <a class="btn small" target="_blank" href="https://youtube.com/watch?v=${esc(comment.videoId)}&lc=${esc(comment.id)}">Open</a>
          </div>
        </div>
      `;
    })
    .join('');
}

app.get('/', (req, res) => {
  checkDailyReset();

  const page = req.query.page || 'dashboard';
  const filter = req.query.filter || 'all';
  const connected = !!refreshToken;
  const quotaPct = Math.min(100, Math.round((stats.quotaUsed / DAILY_QUOTA) * 100));

  const unrepliedCount = scannedComments.filter(c => !c.replied && !c.skipped).length;

  res.send(`
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta http-equiv="refresh" content="20">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(CHANNEL_NAME)} Reply Bot</title>
  <style>
    * { box-sizing: border-box; }
    body { margin:0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background:#090909; color:#e5e7eb; }
    a { color:inherit; text-decoration:none; }
    .wrap { display:grid; grid-template-columns:220px 1fr; min-height:100vh; }
    .side { background:#111; border-right:1px solid #222; padding:16px; }
    .logo { font-weight:800; font-size:18px; margin-bottom:20px; }
    .nav a { display:block; padding:10px; border-radius:8px; color:#9ca3af; margin-bottom:4px; }
    .nav a.active, .nav a:hover { background:#1f2937; color:white; }
    .main { padding:24px; }
    .title { font-size:24px; font-weight:800; margin-bottom:4px; }
    .sub { color:#9ca3af; margin-bottom:20px; }
    .grid { display:grid; grid-template-columns:repeat(5,1fr); gap:12px; margin-bottom:16px; }
    .card { background:#111; border:1px solid #222; border-radius:12px; padding:16px; margin-bottom:16px; }
    .label { color:#6b7280; font-size:11px; text-transform:uppercase; letter-spacing:.05em; }
    .num { font-size:26px; font-weight:800; margin-top:4px; }
    .btnrow { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:16px; }
    .btn { display:inline-block; padding:9px 14px; background:#1f2937; border:1px solid #333; border-radius:8px; font-size:13px; }
    .btn:hover { background:#374151; }
    .blue { background:#1d4ed8; border-color:#1d4ed8; color:white; }
    .green { background:#16a34a; border-color:#16a34a; color:white; }
    .red { background:#dc2626; border-color:#dc2626; color:white; }
    .small { padding:6px 10px; font-size:12px; }
    .tabs { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:14px; }
    .tab { padding:7px 11px; border:1px solid #333; border-radius:999px; color:#9ca3af; font-size:12px; }
    .tab.active { background:#1d4ed8; border-color:#1d4ed8; color:white; }
    .comment { background:#111; border:1px solid #222; border-radius:12px; padding:14px; margin-bottom:10px; }
    .comment-top { display:flex; align-items:center; gap:10px; margin-bottom:10px; }
    .avatar { width:34px; height:34px; border-radius:50%; background:#1f2937; }
    .author { font-weight:700; }
    .time { color:#6b7280; font-size:12px; }
    .status { margin-left:auto; font-size:11px; padding:3px 8px; border-radius:999px; }
    .good { color:#22c55e; background:rgba(34,197,94,.1); }
    .warn { color:#f59e0b; background:rgba(245,158,11,.1); }
    .bad { color:#ef4444; background:rgba(239,68,68,.1); }
    .comment-text { color:#d1d5db; line-height:1.5; margin-bottom:10px; }
    .actions { display:flex; gap:6px; }
    .log { list-style:none; padding:0; margin:0; max-height:300px; overflow:auto; }
    .log li { border-bottom:1px solid #1f2937; padding:7px 0; color:#9ca3af; font-size:13px; }
    .empty { color:#6b7280; text-align:center; padding:30px; }
    .bar { background:#222; height:8px; border-radius:999px; overflow:hidden; }
    .fill { height:100%; background:#22c55e; width:${quotaPct}%; }
    .video-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(230px,1fr)); gap:12px; }
    .video { background:#111; border:1px solid #222; border-radius:12px; overflow:hidden; }
    .video img { width:100%; aspect-ratio:16/9; object-fit:cover; background:#1f2937; }
    .video-body { padding:10px; }
    .video-title { font-size:13px; font-weight:700; margin-bottom:8px; }
    @media(max-width:800px){ .wrap{grid-template-columns:1fr}.side{display:none}.grid{grid-template-columns:1fr 1fr}.main{padding:16px} }
  </style>
</head>
<body>
<div class="wrap">
  <div class="side">
    <div class="logo">${esc(CHANNEL_NAME)} Bot</div>
    <div class="nav">
      <a class="${page === 'dashboard' ? 'active' : ''}" href="/?page=dashboard">Dashboard</a>
      <a class="${page === 'comments' ? 'active' : ''}" href="/?page=comments">Comments (${unrepliedCount})</a>
      <a class="${page === 'videos' ? 'active' : ''}" href="/?page=videos">Reply by Video</a>
      <a class="${page === 'history' ? 'active' : ''}" href="/?page=history">Reply History</a>
      <a class="${page === 'settings' ? 'active' : ''}" href="/?page=settings">Settings</a>
    </div>
  </div>

  <div class="main">
    ${
      page === 'dashboard'
        ? `
          <div class="title">Dashboard</div>
          <div class="sub">Replies only to comments where your channel has not already replied in the thread.</div>

          ${!connected ? `<div class="card bad">Not connected. <a href="/auth"><strong>Connect YouTube</strong></a></div>` : ''}

          <div class="grid">
            <div class="card"><div class="label">Replies</div><div class="num">${stats.totalReplied}</div></div>
            <div class="card"><div class="label">Skipped</div><div class="num">${stats.totalSkipped}</div></div>
            <div class="card"><div class="label">Closed Threads</div><div class="num">${closedThreadIds.size}</div></div>
            <div class="card"><div class="label">Quota Used</div><div class="num">${stats.quotaUsed}</div></div>
            <div class="card"><div class="label">Resets In</div><div class="num" style="font-size:20px">${timeUntilReset()}</div></div>
          </div>

          <div class="card">
            <div class="label">Quota ${stats.quotaUsed} / ${DAILY_QUOTA} · ${repliesLeft()} replies left</div>
            <br>
            <div class="bar"><div class="fill"></div></div>
          </div>

          <div class="btnrow">
            ${!connected ? `<a class="btn red" href="/auth">Connect YouTube</a>` : ''}
            ${connected && !botRunning ? `<a class="btn blue" href="/bot/start">Start Auto Bot</a>` : ''}
            ${botRunning ? `<a class="btn red" href="/bot/stop">Stop Bot</a>` : ''}
            ${connected ? `<a class="btn" href="/bot/run-now">Run Latest Now</a>` : ''}
          </div>

          <div class="card">
            <div class="label">Catch up by time</div>
            <br>
            <div class="btnrow">${renderFilterButtons()}</div>
          </div>

          <div class="card">
            <div class="label">Check interval</div>
            <br>
            <div class="btnrow">
              ${[5,15,30,60,360,1440,10080].map(m => `<a class="btn ${checkIntervalMins === m ? 'blue' : ''}" href="/bot/interval/${m}">${fmtInterval(m)}</a>`).join('')}
            </div>
          </div>

          <div class="card">
            <div class="label">Activity log</div>
            <ul class="log">
              ${logs.map(l => `<li>[${new Date(l.time).toLocaleTimeString('en-GB')}] ${esc(l.msg)}</li>`).join('') || '<li>No activity yet.</li>'}
            </ul>
          </div>
        `
        : ''
    }

    ${
      page === 'comments'
        ? `
          <div class="title">Comments</div>
          <div class="sub">Scan comments and manually reply. Already-replied threads are filtered out.</div>

          <div class="btnrow">
            <a class="btn blue" href="/scan?page=comments&filter=${esc(filter)}">Scan Comments</a>
            <a class="btn green" href="/bot/catchup?filter=${esc(filter)}&page=comments">Reply This Filter</a>
          </div>

          <div class="tabs">${renderFilterTabs(filter)}</div>
          ${renderComments(filter)}
        `
        : ''
    }

    ${
      page === 'videos'
        ? `
          <div class="title">Reply by Video</div>
          <div class="sub">Select a specific video and reply only to comments that have not been responded to.</div>

          <div class="btnrow">
            <a class="btn blue" href="/load-videos">Load My Videos</a>
          </div>

          ${
            videoList.length === 0
              ? `<div class="empty">Click Load My Videos.</div>`
              : `<div class="video-grid">
                  ${videoList.map(v => `
                    <div class="video">
                      <img src="${esc(v.thumbnail)}">
                      <div class="video-body">
                        <div class="video-title">${esc(v.title)}</div>
                        <div class="btnrow">
                          <a class="btn small blue" href="/bot/catchup?videoId=${esc(v.id)}&filter=all&page=videos">Reply all</a>
                          <a class="btn small" href="/scan?videoId=${esc(v.id)}&page=comments&filter=all">Scan</a>
                        </div>
                      </div>
                    </div>
                  `).join('')}
                </div>`
          }
        `
        : ''
    }

    ${
      page === 'history'
        ? `
          <div class="title">Reply History</div>
          <div class="sub">This shows what the bot has replied to.</div>

          ${
            replyHistory.length === 0
              ? `<div class="empty">No reply history yet.</div>`
              : replyHistory.slice(0, 150).map(h => `
                  <div class="comment">
                    <div class="comment-top">
                      <div>
                        <div class="author">${esc(h.author)}</div>
                        <div class="time">${new Date(h.time).toLocaleString('en-GB')}</div>
                      </div>
                      <span class="status good">Replied</span>
                    </div>
                    <div class="comment-text"><strong>Comment:</strong> ${esc(h.comment)}</div>
                    <div class="comment-text"><strong>Reply:</strong> ${esc(h.reply)}</div>
                    <a class="btn small" target="_blank" href="https://youtube.com/watch?v=${esc(h.videoId)}&lc=${esc(h.commentId)}">Open on YouTube</a>
                  </div>
                `).join('')
          }
        `
        : ''
    }

    ${
      page === 'settings'
        ? `
          <div class="title">Settings</div>
          <div class="sub">Bot setup and safety logic.</div>

          <div class="card">
            <div class="label">YouTube Connection</div>
            <br>
            ${connected ? 'Connected.' : 'Not connected.'}
            <br><br>
            <a class="btn blue" href="/auth">${connected ? 'Reconnect YouTube' : 'Connect YouTube'}</a>
          </div>

          <div class="card">
            <div class="label">Reply Style</div>
            <br>
            Channel name: ${esc(CHANNEL_NAME)}<br>
            Reply tone: ${esc(REPLY_TONE)}<br>
            Reply length: ${esc(REPLY_LENGTH)}
          </div>

          <div class="card">
            <div class="label">Safety Logic</div>
            <br>
            ✅ Checks YouTube before replying<br>
            ✅ Closes a thread once your channel has replied<br>
            ✅ Does not reply again when the viewer replies back<br>
            ✅ Skips duplicate complaints<br>
            ✅ Skips repeated copy-paste comments<br>
            ✅ Saves history in data/reply-state.json
          </div>
        `
        : ''
    }
  </div>
</div>
</body>
</html>
  `);
});

app.get('/auth', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;

  if (!clientId) return res.send('GOOGLE_CLIENT_ID not set');

  const oauth2 = new google.auth.OAuth2(
    clientId,
    process.env.GOOGLE_CLIENT_SECRET,
    getRedirectUri()
  );

  const url = oauth2.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: ['https://www.googleapis.com/auth/youtube.force-ssl'],
  });

  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code } = req.query;

  if (!code) return res.send('No code received.');

  try {
    const oauth2 = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      getRedirectUri()
    );

    const { tokens } = await oauth2.getToken(code);

    refreshToken = tokens.refresh_token || refreshToken;
    stats.quotaUsed = 0;

    if (tokens.refresh_token) {
      console.log('YOUTUBE_REFRESH_TOKEN=', tokens.refresh_token);
      log('YouTube connected. Add YOUTUBE_REFRESH_TOKEN to Railway variables.', 'success');
    } else {
      log('Connected, but no new refresh token returned.', 'warn');
    }

    res.redirect('/');
  } catch (e) {
    res.send('Auth error: ' + e.message);
  }
});

app.get('/scan', async (req, res) => {
  const page = req.query.page || 'dashboard';
  const videoId = req.query.videoId || null;
  const filter = req.query.filter || 'all';

  res.redirect(`/?page=${page}&filter=${filter}`);

  if (!refreshToken) return;

  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);

    scannedComments = await scanComments(auth, channelId, {
      videoId,
      dateFilter: filter,
      maxPages: 10,
    });

    log(`Scanned ${scannedComments.length} safe unreplied comments.`, 'success');
  } catch (e) {
    if (e.message !== 'SESSION_EXPIRED') {
      log('Scan error: ' + e.message, 'error');
    }
  }
});

app.get('/load-videos', async (req, res) => {
  res.redirect('/?page=videos');

  if (!refreshToken) return;

  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);

    videoList = await fetchChannelVideos(auth, channelId);

    log(`Loaded ${videoList.length} videos.`, 'success');
  } catch (e) {
    if (e.message !== 'SESSION_EXPIRED') {
      log('Load videos error: ' + e.message, 'error');
    }
  }
});

app.get('/reply-one/:id', async (req, res) => {
  const page = req.query.page || 'comments';
  const filter = req.query.filter || 'all';

  res.redirect(`/?page=${page}&filter=${filter}`);

  const comment = scannedComments.find(c => c.id === req.params.id);

  if (!comment || comment.replied || comment.skipped) return;

  try {
    const auth = await getAuthClient();
    const channelId = await getChannelId(auth);

    const result = await replyToComment(auth, channelId, comment);

    log(
      result.replied ? `Manually replied to ${comment.author}.` : `Manual reply skipped: ${result.reason}`,
      result.replied ? 'success' : 'warn'
    );
  } catch (e) {
    if (e.message !== 'SESSION_EXPIRED') {
      log('Reply error: ' + e.message, 'error');
    }
  }
});

app.get('/bot/start', (req, res) => {
  startBot();
  res.redirect('/');
});

app.get('/bot/stop', (req, res) => {
  stopBot();
  res.redirect('/');
});

app.get('/bot/run-now', async (req, res) => {
  res.redirect('/');
  await runBotCycle('all');
});

app.get('/bot/catchup', async (req, res) => {
  const filter = req.query.filter || 'all';
  const videoId = req.query.videoId || null;
  const page = req.query.page || 'dashboard';

  res.redirect(`/?page=${page}&filter=${filter}`);

  runCatchUp({
    dateFilter: filter,
    videoId,
  });
});

app.get('/bot/interval/:mins', (req, res) => {
  const mins = parseInt(req.params.mins, 10);

  if ([5, 15, 30, 60, 360, 1440, 10080].includes(mins)) {
    setIntervalMins(mins);
  }

  res.redirect('/');
});

app.get('/bot/autopause/:pct', (req, res) => {
  const pct = parseInt(req.params.pct, 10);

  if ([70, 80, 90, 95].includes(pct)) {
    autoPauseAt = pct;
    log(`Auto-pause set to ${pct}%.`, 'success');
  }

  res.redirect('/');
});

app.get('/debug', (req, res) => {
  res.json({
    connected: !!refreshToken,
    botRunning,
    catchingUp,
    stats,
    scannedCount: scannedComments.length,
    videoCount: videoList.length,
    repliedCommentIds: repliedCommentIds.size,
    closedThreadIds: closedThreadIds.size,
    skippedCommentIds: skippedCommentIds.size,
    historyCount: replyHistory.length,
  });
});

app.listen(PORT, () => {
  log(`Server running on port ${PORT}.`, 'success');

  if (refreshToken && process.env.AUTO_START === 'true') {
    startBot();
  }
});
