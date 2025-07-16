// rentcafe/job.js
const { getApartmentAvailability } = require('./rentcafeAvailability');
const { getAllItemsFromWebflow }   = require('./webflow');
const { syncWithWebflow }          = require('./webflowSync');

async function runSyncJob () {
  const stamp = new Date().toISOString();
  console.log(`[RentCafe] ▶︎ sync start ${stamp}`);

  /* 1 – pull from RentCafe */
  let data;
  try {
    data = await getApartmentAvailability(
      'yardi@wearewherever.com',
      process.env.RENTCAFE_VENDOR_TOKEN_SATURDAY,
      process.env.RENTCAFE_COMPANY_CODE_SATURDAY,
      process.env.RENTCAFE_PROPERTY_CODE_REVELRY
    );
  } catch (err) {
    console.error('[RentCafe] token / fetch failed →', err?.response?.data || err);
    return;
  }

  /* 2 – current Webflow state */
  const items = await getAllItemsFromWebflow(
    process.env.WEBFLOW_TOKEN_REVELRY,
    process.env.WEBFLOW_COLLECTION_ID_REVELRY
  );

  /* 3 – diff + push */
  await syncWithWebflow(
    data.apartmentAvailabilities || [],
    items,
    process.env.WEBFLOW_TOKEN_REVELRY,
    process.env.WEBFLOW_COLLECTION_ID_REVELRY
  );

  console.log(`[RentCafe] ✓ sync done ${new Date().toISOString()}`);
}

module.exports = { runSyncJob };
