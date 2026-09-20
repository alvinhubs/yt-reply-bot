const { google } = require('googleapis');
const config = require('../config');
const { spend } = require('./quota');

const oauth2Client = new google.auth.OAuth2(
  config.youtube.clientId,
  config.youtube.clientSecret
);
oauth2Client.setCredentials({ refresh_token: config.youtube.refreshToken });

const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

/**
 * List top-level comment threads for a video, newest first, handling pagination.
 * Cost: 1 unit per page, regardless of page size.
 * `part=snippet,replies` pulls up to 5 inline replies per thread for free —
 * enough to detect an existing owner reply without a second API call in most cases.
 */
async function listCommentThreads(videoId, { maxPages = 10 } = {}) {
  const threads = [];
  let pageToken;
  for (let page = 0; page < maxPages; page++) {
    const res = await youtube.commentThreads.list({
      part: ['snippet', 'replies'],
      videoId,
      maxResults: 100,
      order: 'time',
      pageToken,
      textFormat: 'plainText',
    });
    await spend(1, `commentThreads.list video=${videoId} page=${page}`);
    threads.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
    if (!pageToken) break;
  }
  return threads;
}

/**
 * A thread can have more replies than the 5 inlined by commentThreads.list.
 * Only called as a fallback when totalReplyCount > items returned inline,
 * so it's rare, not routine — keeps the common path cheap (1 unit/page).
 */
async function listAllReplies(parentId) {
  const replies = [];
  let pageToken;
  do {
    const res = await youtube.comments.list({
      part: ['snippet'],
      parentId,
      maxResults: 100,
      pageToken,
      textFormat: 'plainText',
    });
    await spend(1, `comments.list parent=${parentId}`);
    replies.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);
  return replies;
}

/** Post a reply to a top-level comment. Cost: 50 units. */
async function postReply(parentId, text) {
  const res = await youtube.comments.insert({
    part: ['snippet'],
    requestBody: {
      snippet: { parentId, textOriginal: text },
    },
  });
  await spend(50, `comments.insert parent=${parentId}`);
  return res.data;
}

/** Basic video metadata (title), 1 unit. Used when adding a video to track. */
async function getVideoTitle(videoId) {
  const res = await youtube.videos.list({ part: ['snippet'], id: [videoId] });
  await spend(1, `videos.list id=${videoId}`);
  const item = res.data.items && res.data.items[0];
  return item ? item.snippet.title : null;
}

module.exports = { listCommentThreads, listAllReplies, postReply, getVideoTitle };
