const { Queue } = require('bullmq');
const IORedis = require('ioredis');
const config = require('../config');

const connection = new IORedis(config.redis.url, { maxRetriesPerRequest: null });

// One queue for the actual "generate + post reply" work, so posting is
// serialized and rate-limited independently of how fast scanning finds
// candidates.
const replyQueue = new Queue('reply-jobs', { connection });

module.exports = { connection, replyQueue };
