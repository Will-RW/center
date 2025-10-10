require('dotenv').config();
const express = require('express');
const cron    = require('node-cron');

const app = express();

/* --------------------  Wized dynamic script  -------------------- */
app.get('/wized.js', require('./wized/route'));

/* --------------------  RentCafe → Webflow  ---------------------- */
// Feature flag: set ENABLE_RENTCAFE=1 to re-enable later
const ENABLE_RENTCAFE = process.env.ENABLE_RENTCAFE === '1';

if (ENABLE_RENTCAFE) {
  const { runSyncJob: rentCafeJob } = require('./rentcafe/job');
  // schedule only when enabled
  cron.schedule('0 */4 * * *', rentCafeJob);                 // every 4 h
  app.get('/sync-rentcafe', async (_, res) => {
    await rentCafeJob();
    res.end('RentCafe sync complete');
  });
  console.log('[boot] RentCafe: enabled');
} else {
  // do NOT require('./rentcafe/job'); keep fully inert
  app.get('/sync-rentcafe', (_, res) => {
    res.status(410).end('RentCafe sync is temporarily disabled');
  });
  console.log('[boot] RentCafe: disabled');
}

/* --------------------  On-Site → Webflow  ----------------------- */
const { main: onSiteJob } = require('./onsite/onSiteSync');
cron.schedule('*/15 * * * *', onSiteJob);                    // every 15 min
app.get('/sync-onsite', async (_, res) => {
  await onSiteJob();
  res.end('On-Site sync complete');
});

/* --------------------  health-check root  ---------------------- */
app.get('/', (_, res) => res.send('OK – unified service running'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () =>
  console.log(`[boot] Server listening on ${PORT}`)
);
