const { Worker } = require('bullmq');
const config = require('../config');
const db = require('../db/db');
const { connection } = require('./queue');
const { canSpend } = require('../youtube/quota');
const { generateReply } = require('../replies/generateReply');
const { postReply } = require('../youtube/client');

/**
 * Processes one reply job at a time (concurrency: 1) so posts go out spaced
 * apart rather than in a burst — friendlier to the API and to how a real
 * person actually replies to comments.
 */
const worker = new Worker(
  'reply-jobs',
  async (job) => {
    const { threadId, videoId, parentCommentId, commentText } = job.data;

    // Quota may have been spent by other work since this job was enqueued —
    // check again right before actually posting.
    if (!(await canSpend(50))) {
      throw new Error('Quota threshold reached — job will be retried later');
    }

    // Belt-and-braces: don't double-post if something else handled this
    // thread between enqueue and now (e.g. manual catch-up + scheduled scan
    // both firing).
    const { rows } = await db.query(
      'SELECT 1 FROM replied_threads WHERE thread_id = $1',
      [threadId]
    );
    if (rows.length > 0) return { skipped: true, reason: 'already handled' };

    const videoRow = await db.query(
      'SELECT title FROM videos WHERE video_id = $1',
      [videoId]
    );
    const videoTitle = videoRow.rows[0] && videoRow.rows[0].title;

    const replyText = await generateReply({ commentText, videoTitle });
    const posted = await postReply(parentCommentId, replyText);

    await db.query(
      `INSERT INTO replied_threads
         (thread_id, video_id, parent_comment_id, original_comment, reply_comment_id, reply_text, source)
       VALUES ($1,$2,$3,$4,$5,$6,'bot')
       ON CONFLICT (thread_id) DO NOTHING`,
      [threadId, videoId, parentCommentId, commentText, posted.id, replyText]
    );

    return { posted: true, replyText };
  },
  {
    connection,
    concurrency: 1,
    limiter: { max: 1, duration: config.posting.delayMs },
  }
);

worker.on('failed', (job, err) => {
  console.error(`[reply-worker] job ${job.id} failed: ${err.message}`);
});

module.exports = worker;
