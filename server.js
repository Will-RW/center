require('dotenv').config();
const express = require('express');
const cron    = require('node-cron');

const app = express();

/* --------------------  Wized dynamic script  -------------------- */
app.get('/wized.js', require('./wized/route'));

/* --------------------  RentCafe → Webflow  ---------------------- */
const { runSyncJob: rentCafeJob } = require('./rentcafe/job');
cron.schedule('0 */4 * * *', rentCafeJob);                 // every 4 h
app.get('/sync-rentcafe', async (_, res) => {
  await rentCafeJob();
  res.end('RentCafe sync complete');
});

/* --------------------  On-Site → Webflow  ----------------------- */
const { main: onSiteJob } = require('./onsite/onSiteSync');
cron.schedule('*/15 * * * *', onSiteJob);                  // every 15 min
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
