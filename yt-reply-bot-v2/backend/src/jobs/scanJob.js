const db = require('../db/db');
const { listCommentThreads } = require('../youtube/client');
const { shouldReply } = require('../filter/shouldReply');
const { canSpend } = require('../youtube/quota');
const { replyQueue } = require('./queue');

/**
 * Scans one video for never-replied-to threads and enqueues a reply job for
 * each eligible one. This function only *reads* (cheap, 1 unit/page) —
 * actual posting (50 units each) happens in the worker, which checks quota
 * again right before every single post.
 */
async function scanVideo(videoId) {
  if (!(await canSpend(1))) {
    console.log(`[scan] Skipping ${videoId} — quota threshold reached.`);
    return { scanned: 0, enqueued: 0, pausedForQuota: true };
  }

  const threads = await listCommentThreads(videoId);
  let enqueued = 0;

  for (const thread of threads) {
    const eligible = await shouldReply(thread);
    if (!eligible) continue;

    await replyQueue.add('reply', {
      threadId: thread.id,
      videoId,
      parentCommentId: thread.snippet.topLevelComment.id,
      commentText: thread.snippet.topLevelComment.snippet.textDisplay,
    });
    enqueued++;
  }

  await db.query(
    'UPDATE videos SET last_scanned_at = now() WHERE video_id = $1',
    [videoId]
  );

  return { scanned: threads.length, enqueued, pausedForQuota: false };
}

/** Scans every active tracked video. Used by the interval scheduler. */
async function scanAllActiveVideos() {
  const { rows } = await db.query(
    'SELECT video_id FROM videos WHERE is_active = true'
  );
  const results = {};
  for (const { video_id } of rows) {
    results[video_id] = await scanVideo(video_id);
  }
  return results;
}

module.exports = { scanVideo, scanAllActiveVideos };
