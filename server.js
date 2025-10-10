require('dotenv').config();
const express = require('express');
const cron = require('node-cron');

const app = express();

/* --------------------  Wized dynamic script  -------------------- */
app.get('/wized.js', require('./wized/route'));

/* --------------------  RentCafe → Webflow  ---------------------- */
// Feature flag: set ENABLE_RENTCAFE=1 to enable; unset/0 to disable
const ENABLE_RENTCAFE = process.env.ENABLE_RENTCAFE === '1';

if (ENABLE_RENTCAFE) {
  const { runSyncJob: rentCafeJob } = require('./rentcafe/job');
  cron.schedule('0 */4 * * *', rentCafeJob); // every 4 h
  app.get('/sync-rentcafe', async (_, res) => {
    await rentCafeJob();
    res.end('RentCafe sync complete');
  });
  console.log('[boot] RentCafe: enabled');
} else {
  // keep route but inert (useful if something is still pinging it)
  app.get('/sync-rentcafe', (_, res) => {
    res.status(410).end('RentCafe sync is temporarily disabled');
  });
  console.log('[boot] RentCafe: disabled');
}

/* --------------------  On-Site → Webflow  ----------------------- */
const { main: onSiteJob } = require('./onsite/onSiteSync');

// simple in-process mutex to prevent overlapping runs
let onSiteRunning = false;
async function safeOnSiteRun(trigger = 'cron') {
  if (onSiteRunning) {
    console.log(`[INFO] ${new Date().toISOString()} ⏭︎ OnSite skipped (already running) [trigger=${trigger}]`);
    return;
  }
  onSiteRunning = true;
  try {
    await onSiteJob();
  } finally {
    onSiteRunning = false;
  }
}

cron.schedule('*/15 * * * *', () => safeOnSiteRun('cron')); // every 15 min
app.get('/sync-onsite', async (_, res) => {
  await safeOnSiteRun('manual');
  res.end('On-Site sync complete');
});

/* --------------------  health-check root  ----------------------- */
app.get('/', (_, res) => res.send('OK – unified service running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`[boot] Server listening on ${PORT}`)
);
