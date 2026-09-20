const config = require('../config');
const db = require('../db/db');
const { listAllReplies } = require('../youtube/client');

/**
 * The rule (confirmed, simplest version): skip a thread if the channel owner
 * has EVER replied in it, for any reason. Don't re-reply regardless of
 * whether the original commenter responded afterwards.
 *
 * Two checks, cheapest first:
 *  1. Our own DB — every reply the bot posts is recorded in replied_threads.
 *     This covers 99% of cases with zero extra API calls.
 *  2. The thread's own inline `replies` (already fetched for free by
 *     commentThreads.list) — catches replies YOU posted manually, outside
 *     the bot, before it ever saw the thread.
 *  3. Only if totalReplyCount is larger than what came back inline (YouTube
 *     inlines up to 5) do we pay for comments.list to check the rest — this
 *     is the rare case, not the common path.
 */
async function shouldReply(thread) {
  const threadId = thread.id;

  const { rows } = await db.query(
    'SELECT 1 FROM replied_threads WHERE thread_id = $1',
    [threadId]
  );
  if (rows.length > 0) return false;

  const snippet = thread.snippet;
  const totalReplyCount = snippet.totalReplyCount || 0;
  if (totalReplyCount === 0) return true;

  const inlineReplies = (thread.replies && thread.replies.comments) || [];
  const ownerRepliedInline = inlineReplies.some(
    (r) => r.snippet.authorChannelId?.value === config.youtube.channelId
  );
  if (ownerRepliedInline) {
    await recordPreExisting(thread, inlineReplies);
    return false;
  }

  // Inline replies didn't cover everything — go check the rest (paid call).
  if (totalReplyCount > inlineReplies.length) {
    const allReplies = await listAllReplies(snippet.topLevelComment.id);
    const ownerReplied = allReplies.some(
      (r) => r.snippet.authorChannelId?.value === config.youtube.channelId
    );
    if (ownerReplied) {
      await recordPreExisting(thread, allReplies);
      return false;
    }
  }

  return true;
}

async function recordPreExisting(thread, replies) {
  const ownerReply = replies.find(
    (r) => r.snippet.authorChannelId?.value === config.youtube.channelId
  );
  await db.query(
    `INSERT INTO replied_threads
       (thread_id, video_id, parent_comment_id, original_comment, reply_comment_id, reply_text, source)
     VALUES ($1,$2,$3,$4,$5,$6,'pre_existing')
     ON CONFLICT (thread_id) DO NOTHING`,
    [
      thread.id,
      thread.snippet.videoId,
      thread.snippet.topLevelComment.id,
      thread.snippet.topLevelComment.snippet.textDisplay,
      ownerReply ? ownerReply.id : null,
      ownerReply ? ownerReply.snippet.textDisplay : null,
    ]
  );
}

module.exports = { shouldReply };
