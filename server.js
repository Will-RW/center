// server.js
require('dotenv').config();
const express = require('express');
const cron    = require('node-cron');

const app = express();

/* --------------------  CORS (for Framer editor/preview)  -------------------- */
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // tighten to your Framer domains if desired
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  next();
});

/* --------------------  Wized dynamic script  -------------------- */
app.get('/wized.js', require('./wized/route'));

/* --------------------  RentCafe → Webflow (feature-flag)  -------------------- */
const ENABLE_RENTCAFE = process.env.ENABLE_RENTCAFE === '1';

if (ENABLE_RENTCAFE) {
  const { runSyncJob: rentCafeJob } = require('./rentcafe/job');
  cron.schedule('0 */4 * * *', rentCafeJob); // every 4 hours
  app.get('/sync-rentcafe', async (_, res) => {
    await rentCafeJob();
    res.end('RentCafe sync complete');
  });
  console.log('[boot] RentCafe: enabled');
} else {
  // keep the route but inert so old pings don’t do anything
  app.get('/sync-rentcafe', (_, res) => {
    res.status(410).end('RentCafe sync is temporarily disabled');
  });
  console.log('[boot] RentCafe: disabled');
}

/* --------------------  On-Site → Webflow  -------------------- */
const { main: onSiteJob } = require('./onsite/onSiteSync');

// simple in-process mutex to prevent overlapping runs
let onSiteRunning = false;
async function safeOnSiteRun(trigger = 'cron') {
  if (onSiteRunning) {
    console.log(`[INFO] ${new Date().toISOString()} ⏭︎ OnSite skipped (already running) [trigger=${trigger}]`);
    return;
  }
  onSiteRunning = true;
  try { await onSiteJob(); }
  finally { onSiteRunning = false; }
}

cron.schedule('*/15 * * * *', () => safeOnSiteRun('cron')); // every 15 min
app.get('/sync-onsite', async (_, res) => {
  await safeOnSiteRun('manual');
  res.end('On-Site sync complete');
});

/* --------------------  RentCafe → Framer CMS Data Sync  -------------------- */
/* This mounts the two endpoints:
   - GET /framer/cms-sync/:property/units?since=ISO
   - GET /framer/cms-sync/:property/unit/:slug
   The implementation lives in rentcafe/framerSync.js
*/
app.use(require('./rentcafe/framerSync'));

/* --------------------  health-check root  -------------------- */
app.get('/', (_, res) => res.send('OK – unified service running'));

/* --------------------  boot  -------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[boot] Server listening on ${PORT}`);
});
