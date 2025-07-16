/************************************************
 * onsite/onSiteSync.js – Self‑contained version
 * Combines logger, utils, and sync logic in ONE file
 ************************************************/

// ----------------------  External libs ----------------------
const fetch  = require('node-fetch'); // Webflow REST v2
const axios  = require('axios');      // OnSite XML endpoints
const xml2js = require('xml2js');     // XML → JS
const cron   = require('node-cron');  // Scheduler

// ----------------------  Lightweight logger -----------------
const pino = require('pino');
const isDev = process.env.NODE_ENV !== 'production';
const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  transport: isDev ? {
    target: 'pino-pretty',
    options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname' }
  } : undefined,
  timestamp: pino.stdTimeFunctions.isoTime,
});
logger.info('📣 OnSite sync script booted');

// ----------------------  Utility helpers --------------------
function convertNumber(value) {
  if (typeof value === 'object' && value && value._) value = value._;
  if (typeof value === 'string') value = value.replace(/[^0-9.-]+/g, '');
  const num = parseFloat(value);
  if (isNaN(num)) { logger.warn(`convertNumber failed: ${value}`); return null; }
  return num;
}

function convertBoolean(value) {
  if (typeof value === 'object' && value && value._) value = value._;
  if (typeof value === 'string') return value.toLowerCase() === 'true';
  return Boolean(value);
}

function convertDate(value) {
  if (!value || (typeof value === 'object' && value.$?.nil === 'true')) return null;
  if (typeof value === 'object' && value._) value = value._;
  if (typeof value === 'string') {
    const d = new Date(value);
    if (!isNaN(d)) return d.toISOString();
  }
  logger.warn(`convertDate failed: ${JSON.stringify(value)}`);
  return null;
}

function generateSlug(str) {
  if (typeof str !== 'string' || !str.trim()) { logger.warn(`Bad slug input: ${str}`); return ''; }
  return str.trim().toLowerCase().replace(/\s+/g, '-');
}

// ----------------------  Credentials ------------------------
const { ONSITE_USERNAME, ONSITE_PASSWORD } = process.env;

// ----------------------  Property endpoints -----------------
const propertyEndpoints = [
  {
    name: 'NOLANMAINS',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567452/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567452.xml',
    webflowApiKey: process.env.NOLANMAINS_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.NOLANMAINS_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.NOLANMAINS_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.NOLANMAINS_SITE_ID,
    customDomains: ['66db288b0e91e910a34cb876'],
  },
  {
    name: 'ALVERA',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567445/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567445.xml',
    webflowApiKey: process.env.ALVERA_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.ALVERA_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.ALVERA_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.ALVERA_SITE_ID,
    customDomains: ['62edf2bf53f04db521620dfb'],
  },
  {
    name: 'ZENITH',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567457/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567457.xml',
    webflowApiKey: process.env.ZENITH_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.ZENITH_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.ZENITH_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.ZENITH_SITE_ID,
    customDomains: ['67225edaa64d92c89b25556f'],
  },
  {
    name: 'THEWALKWAY',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567456/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567456.xml',
    webflowApiKey: process.env.THEWALKWAY_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.THEWALKWAY_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.THEWALKWAY_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.THEWALKWAY_SITE_ID,
    customDomains: ['623532ef11b2ba7054bbca19'],
  },
];

// ----------------------  OnSite helpers ---------------------
async function fetchXML(url) {
  logger.info(`📡 GET ${url}`);
  const { data } = await axios.get(url, {
    auth: { username: ONSITE_USERNAME, password: ONSITE_PASSWORD },
    responseType: 'text',
  });
  return data;
}

function parseXML(xml) {
  return new Promise((res, rej) => {
    xml2js.parseString(xml, { explicitArray: false }, (err, obj) => err ? rej(err) : res(obj));
  });
}

// ----------------------  Webflow helpers --------------------
async function fetchAllWebflowData(collectionId, token, retry = 3) {
  logger.info(`⬇️  Pulling Webflow items ${collectionId}`);
  let items = [], offset = 0, limit = 100;
  while (true) {
    const resp = await fetch(`https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=${limit}`, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!resp.ok) {
      if (resp.status === 429 && retry) {
        const wait = Number(resp.headers.get('Retry-After') || 1);
        logger.warn(`Rate‑limited, retry in ${wait}s`);
        await new Promise(r => setTimeout(r, wait * 1000));
        return fetchAllWebflowData(collectionId, token, retry - 1);
      }
      throw new Error(`Webflow GET failed ${resp.status}`);
    }
    const { items: batch } = await resp.json();
    items = items.concat(batch);
    if (batch.length < limit) break;
    offset += limit;
  }
  return items;
}

function logChanges(oldData, newData) {
  return Object.keys(newData).reduce((arr, k) => {
    const oldV = oldData[k];
    const newV = newData[k];
    if (JSON.stringify(oldV) !== JSON.stringify(newV)) arr.push({ field: k, oldValue: oldV, newValue: newV });
    return arr;
  }, []);
}

async function updateWebflowItem(id, collectionId, fieldData, token, retry = 3) {
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${id}`;
  const resp = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ fieldData }),
  });
  if (!resp.ok) {
    if (resp.status === 429 && retry) {
      const wait = Number(resp.headers.get('Retry-After') || 1);
      logger.warn(`Rate‑limited update, retry ${wait}s`);
      await new Promise(r => setTimeout(r, wait * 1000));
      return updateWebflowItem(id, collectionId, fieldData, token, retry - 1);
    }
    throw new Error(`PATCH ${url} ${resp.status}`);
  }
  return true;
}

function roundUp(n) { return typeof n === 'number' ? Math.ceil(n) : n; }
function getStyleIdValue(f) { return typeof f === 'object' && f ? f._ : f; }
function parseRent(v) {
  if (v && typeof v === 'object' && v._) v = v._;
  if (v && typeof v === 'object') return 0;
  const n = convertNumber(v);
  return typeof n === 'number' ? n : 0;
}

// ----------------------  Units / floorplans -----------------
async function updateUnits(apartment, collectionId, items, token) {
  const { allUnits = [], availableUnits = [] } = apartment;
  const avail = availableUnits.map(u => u['apartment-num']?.toLowerCase());
  for (const unit of allUnits) {
    const num = unit['apartment-num'];
    if (!num) continue;
    const slug = generateSlug(num);
    const item = items.find(i => i.fieldData.slug === slug);
    if (!item) continue;

    const newData = {
      'available-date': convertDate(unit['available-date']),
      'effective-rent-amount': roundUp(convertNumber(unit['effective-rent-amount'])),
      'original-rent-amount': roundUp(convertNumber(unit['rent-amount'])),
      'show-online': convertBoolean(avail.includes(num.toLowerCase())),
    };
    if (!logChanges(item.fieldData, newData).length) continue;
    logger.info(`Updating unit ${slug}`);
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
      'minimum-rent': parseRent(fp['min-rent']),
      'maximum-rent': parseRent(fp['max-rent']),
      'available-units-count': convertNumber(fp['num-available']) || 0,
    };
    if (!logChanges(item.fieldData, newData).length) continue;
    logger.info(`Updating floorplan ${styleId}`);
    await updateWebflowItem(item.id, collectionId, newData, token);
  }
}

// ----------------------  Publish helper ---------------------
async function publishUpdates(siteId, token, customDomainIds = []) {
  const resp = await fetch(`https://api.webflow.com/v2/sites/${siteId}/publish`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ publishToWebflowSubdomain: true, customDomains: customDomainIds }),
  });
  if (!resp.ok) throw new Error(`Publish failed ${await resp.text()}`);
  return true;
}

// ----------------------  Orchestration ----------------------
async function fetchApartmentData() {
  const out = [];
  for (const p of propertyEndpoints) {
    try {
      const unitsXML = await fetchXML(p.unitsUrl);
      const unitsData = await parseXML(unitsXML);
      const availXML = await fetchXML(`${p.unitsUrl}?available_only=true`);
      const availData = await parseXML(availXML);
      const fpXML = await fetchXML(p.floorplansUrl);
      const fpData = await parseXML(fpXML);
      const rawStyles = fpData?.property?.['unit-styles']?.['unit-style'] || [];
      out.push({
        property: p.name,
        allUnits: [].concat(unitsData.units.unit || []),
        availableUnits: [].concat(availData.units.unit || []),
        floorplans: [].concat(rawStyles),
        ...p,
      });
    } catch (err) {
      logger.error(`Failed fetching for ${p.name}:`, err.message);
    }
  }
  return out;
}

async function updateWebflowCollections(apartments) {
  for (const a of apartments) {
    const items = await fetchAllWebflowData(a.apartmentsCollectionId, a.webflowApiKey);
    await updateUnits(a, a.apartmentsCollectionId, items, a.webflowApiKey);
    if (a.property === 'ALVERA') {
      const fps = await fetchAllWebflowData(a.floorplansCollectionId, a.webflowApiKey);
      await updateFloorPlans(a, a.floorplansCollectionId, fps, a.webflowApiKey);
    }
    await publishUpdates(a.siteId, a.webflowApiKey, a.customDomains);
  }
}

async function main() {
  logger.info('▶︎ OnSite sync start');
  const apartments = await fetchApartmentData();
  await updateWebflowCollections(apartments);
  logger.info('✔︎ OnSite sync done');
}

cron.schedule('*/15 * * * *', () => {
  logger.info('⏰ Cron triggered');
  main();
});

// Uncomment to run immediately in dev
// main();
