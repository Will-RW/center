/************************************************
 * onsite/onSiteSync.js – fully self-contained
 *  • No external logger or utils dependencies
 *  • Uses env vars for credentials
 ************************************************/

/* ───── external libraries ───── */
const fetch  = require('node-fetch');   // Webflow API
const axios  = require('axios');        // OnSite XML feeds
const xml2js = require('xml2js');       // XML → JS
const cron   = require('node-cron');    // scheduler

/* ───── tiny logger (console-based) ───── */
const LEVELS  = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
function log(level, ...args) {
  if (LEVELS[level] > CURRENT) return;
  console.log(`[${level.toUpperCase()}] ${new Date().toISOString()}`, ...args);
}
const logger = {
  error: (...a) => log('error', ...a),
  warn : (...a) => log('warn' , ...a),
  info : (...a) => log('info' , ...a),
  debug: (...a) => log('debug', ...a),
};
logger.info('📣 OnSite sync script booted');

/* ───── utility helpers ───── */
const convertNumber = v => {
  if (v && typeof v === 'object' && v._) v = v._;
  if (typeof v === 'string') v = v.replace(/[^0-9.\-]+/g, '');
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};
const convertBoolean = v => {
  if (v && typeof v === 'object' && v._) v = v._;
  return String(v).toLowerCase() === 'true';
};
const convertDate = v => {
  if (!v || (typeof v === 'object' && v.$?.nil === 'true')) return null;
  if (typeof v === 'object' && v._) v = v._;
  const d = new Date(v);
  return isNaN(d) ? null : d.toISOString();
};
const generateSlug = s =>
  String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
const roundUp = n => (typeof n === 'number' ? Math.ceil(n) : n);
const getStyleIdValue = f => (typeof f === 'object' && f ? f._ : f);
const parseRent = v => {
  if (v && typeof v === 'object' && v._) v = v._;
  if (v && typeof v === 'object') return 0;
  const n = convertNumber(v);
  return typeof n === 'number' ? n : 0;
};
const logChanges = (oldData, newData) =>
  Object.keys(newData).reduce((arr, k) => {
    if (JSON.stringify(oldData[k]) !== JSON.stringify(newData[k])) {
      arr.push({ field: k, oldValue: oldData[k], newValue: newData[k] });
    }
    return arr;
  }, []);

/* ───── env credentials ───── */
const { ONSITE_USERNAME, ONSITE_PASSWORD } = process.env;

/* ───── property endpoints ───── */
const propertyEndpoints = [
  {
    name: 'NOLANMAINS',
    unitsUrl:      'https://www.on-site.com/web/api/properties/567452/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567452.xml',
    webflowApiKey:            process.env.NOLANMAINS_WEBFLOW_API_KEY,
    apartmentsCollectionId:   process.env.NOLANMAINS_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId:   process.env.NOLANMAINS_FLOORPLANS_COLLECTION_ID,
    siteId:                   process.env.NOLANMAINS_SITE_ID,
    customDomains: ['66db288b0e91e910a34cb876'],
  },
  {
    name: 'ALVERA',
    unitsUrl:      'https://www.on-site.com/web/api/properties/567445/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567445.xml',
    webflowApiKey:            process.env.ALVERA_WEBFLOW_API_KEY,
    apartmentsCollectionId:   process.env.ALVERA_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId:   process.env.ALVERA_FLOORPLANS_COLLECTION_ID,
    siteId:                   process.env.ALVERA_SITE_ID,
    customDomains: ['62edf2bf53f04db521620dfb'],
  },
  {
    name: 'ZENITH',
    unitsUrl:      'https://www.on-site.com/web/api/properties/567457/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567457.xml',
    webflowApiKey:            process.env.ZENITH_WEBFLOW_API_KEY,
    apartmentsCollectionId:   process.env.ZENITH_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId:   process.env.ZENITH_FLOORPLANS_COLLECTION_ID,
    siteId:                   process.env.ZENITH_SITE_ID,
    customDomains: ['67225edaa64d92c89b25556f'],
  },
  {
    name: 'THEWALKWAY',
    unitsUrl:      'https://www.on-site.com/web/api/properties/567456/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567456.xml',
    webflowApiKey:            process.env.THEWALKWAY_WEBFLOW_API_KEY,
    apartmentsCollectionId:   process.env.THEWALKWAY_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId:   process.env.THEWALKWAY_FLOORPLANS_COLLECTION_ID,
    siteId:                   process.env.THEWALKWAY_SITE_ID,
    customDomains: ['623532ef11b2ba7054bbca19'],
  },
];

/* ───── OnSite helpers ───── */
const fetchXML = async url => {
  logger.debug(`GET ${url}`);
  const { data } = await axios.get(url, {
    auth: { username: ONSITE_USERNAME, password: ONSITE_PASSWORD },
    responseType: 'text',
  });
  return data;
};
const parseXML = xml =>
  new Promise((resolve, reject) =>
    xml2js.parseString(
      xml,
      { explicitArray: false },
      (err, res) => (err ? reject(err) : resolve(res))
    )
  );

/* ───── Webflow helpers ───── */
async function fetchAllWebflowData(collectionId, token, retry = 3) {
  let items = [];
  for (let offset = 0;; offset += 100) {
    const res = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=100`,
      { headers: { Authorization: `Bearer ${token}`, accept: 'application/json' } }
    );
    if (!res.ok) {
      if (res.status === 429 && retry) {
        const wait = Number(res.headers.get('Retry-After') || 1);
        await new Promise(r => setTimeout(r, wait * 1000));
        return fetchAllWebflowData(collectionId, token, retry - 1);
      }
      throw new Error(`Webflow GET ${res.status}`);
    }
    const { items: batch } = await res.json();
    items = items.concat(batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function updateWebflowItem(id, collectionId, fieldData, token, retry = 3) {
  const res = await fetch(
    `https://api.webflow.com/v2/collections/${collectionId}/items/${id}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fieldData }),
    }
  );
  if (!res.ok) {
    if (res.status === 429 && retry) {
      const wait = Number(res.headers.get('Retry-After') || 1);
      await new Promise(r => setTimeout(r, wait * 1000));
      return updateWebflowItem(id, collectionId, fieldData, token, retry - 1);
    }
    throw new Error(`PATCH ${res.status}`);
  }
  return true;
}

async function publishUpdates(siteId, token, customDomains = []) {
  const res = await fetch(`https://api.webflow.com/v2/sites/${siteId}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      publishToWebflowSubdomain: true,
      customDomains,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Publish ${res.status}: ${body}`);
  }
}

/* ───── processors ───── */
async function updateUnits(apartment, collectionId, items, token) {
  const avail = (apartment.availableUnits || []).map(
    u => u['apartment-num']?.toLowerCase()
  );
  for (const unit of apartment.allUnits || []) {
    const num = unit['apartment-num'];
    if (!num) continue;

    const slug = generateSlug(num);
    const item = items.find(i => i.fieldData.slug === slug);
    if (!item) continue;

    const newData = {
      'available-date':        convertDate(unit['available-date']),
      'effective-rent-amount': roundUp(convertNumber(unit['effective-rent-amount'])),
      'original-rent-amount':  roundUp(convertNumber(unit['rent-amount'])),
      'show-online':           convertBoolean(avail.includes(num.toLowerCase())),
    };
    if (!logChanges(item.fieldData, newData).length) continue;

    logger.info(`🏠 Updating unit ${slug}`);
    await updateWebflowItem(item.id, collectionId, newData, token);
  }
}

async function updateFloorPlans(apartment, collectionId, items, token) {
  if (apartment.property !== 'ALVERA') return;
  for (const fp of apartment.floorplans || []) {
    const styleId = String(getStyleIdValue(fp['style-id']) || '');
    if (!styleId) continue;

    const item = items.find(i => i.fieldData.slug === styleId);
    if (!item) continue;

    const newData = {
      'minimum-rent':          parseRent(fp['min-rent']),
      'maximum-rent':          parseRent(fp['max-rent']),
      'available-units-count': convertNumber(fp['num-available']) || 0,
    };
    if (!logChanges(item.fieldData, newData).length) continue;

    logger.info(`🏢 Updating floorplan ${styleId}`);
    await updateWebflowItem(item.id, collectionId, newData, token);
  }
}

/* ───── orchestration ───── */
async function fetchApartmentData() {
  const result = [];
  for (const p of propertyEndpoints) {
    try {
      logger.info(`🔄 Fetching OnSite data for ${p.name}`);

      const [unitsXML, availXML, fpXML] = await Promise.all([
        fetchXML(p.unitsUrl),
        fetchXML(`${p.unitsUrl}?available_only=true`),
        fetchXML(p.floorplansUrl),
      ]);

      const unitsData = await parseXML(unitsXML);
      const availData = await parseXML(availXML);
      const fpData    = await parseXML(fpXML);
      const rawStyles =
        fpData?.property?.['unit-styles']?.['unit-style'] || [];

      result.push({
        property: p.name,
        allUnits:         [].concat(unitsData.units.unit      || []),
        availableUnits:   [].concat(availData.units.unit      || []),
        floorplans:       [].concat(rawStyles                 || []),
        ...p, // keep keys from endpoint definition
      });
    } catch (err) {
      logger.error(`❌ OnSite fetch failed for ${p.name}:`, err.message);
    }
  }
  return result;
}

async function updateWebflowCollections(apartments) {
  for (const a of apartments) {
    const items = await fetchAllWebflowData(
      a.apartmentsCollectionId,
      a.webflowApiKey
    );
    await updateUnits(a, a.apartmentsCollectionId, items, a.webflowApiKey);

    if (a.property === 'ALVERA' && a.floorplansCollectionId) {
      const fps = await fetchAllWebflowData(
        a.floorplansCollectionId,
        a.webflowApiKey
      );
      await updateFloorPlans(a, a.floorplansCollectionId, fps, a.webflowApiKey);
    }

    await publishUpdates(a.siteId, a.webflowApiKey, a.customDomains || []);
  }
}

async function main() {
  try {
    logger.info('▶︎ OnSite sync start');
    const apartments = await fetchApartmentData();
    await updateWebflowCollections(apartments);
    logger.info('✔︎ OnSite sync done');
  } catch (err) {
    logger.error('❌ OnSite sync failed:', err);
  }
}

/* ───── cron schedule ───── */
cron.schedule('*/15 * * * *', () => {
  logger.info('⏰ OnSite cron triggered');
  main();
});

/* Uncomment to run immediately during local testing */
// main();
