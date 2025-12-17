// server.js
require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const { main: appFolioJob } = require('./appfolio/appfolioSync');

const app = express();

/* --------------------  simple in-process mutex  -------------------- */
let appFolioRunning = false;
async function safeAppFolioRun(trigger = 'cron') {
  if (appFolioRunning) {
    console.log(`[INFO] ${new Date().toISOString()} ⏭︎ AppFolio skipped (already running) [trigger=${trigger}]`);
    return;
  }
  appFolioRunning = true;
  try {
    await appFolioJob();
  } finally {
    appFolioRunning = false;
  }
}

/* --------------------  schedule  -------------------- */
/**
 * Choose whatever cadence you want.
 * This mirrors your old On-Site cadence (every 15 minutes).
 */
cron.schedule('*/15 * * * *', () => safeAppFolioRun('cron'));

/* --------------------  manual trigger endpoint  -------------------- */
app.get('/sync-appfolio', async (_, res) => {
  await safeAppFolioRun('manual');
  res.end('AppFolio sync complete');
});

/* --------------------  health-check root  -------------------- */
app.get('/', (_, res) => res.send('OK – AppFolio sync service running'));

/* --------------------  boot  -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] Server listening on ${PORT}`);
  console.log('[boot] Active sync: AppFolio only');
});
