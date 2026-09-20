const express = require('express');
const cors = require('cors');
const config = require('./config');
const apiRoutes = require('./routes/api');
const { initScheduler } = require('./scheduler');

// Starting the worker module registers its listeners (side-effect import).
require('./jobs/replyWorker');

const app = express();
app.use(cors());
app.use(express.json());
app.use('/api', apiRoutes);

app.get('/health', (req, res) => res.json({ ok: true }));

async function start() {
  await initScheduler();
  app.listen(config.port, () => {
    console.log(`[server] yt-reply-bot-v2 listening on :${config.port}`);
  });
}

start().catch((err) => {
  console.error('[server] failed to start', err);
  process.exit(1);
});
