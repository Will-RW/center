/************************************************
 * onsite/onSiteSync.js – fully self-contained
 *  • No external logger or utils dependencies
 *  • Uses env vars for credentials
 ************************************************/

/* ───── external libraries ───── */
const fetch = require('node-fetch');   // Webflow API (v2)
const axios = require('axios');        // OnSite XML feeds
const xml2js = require('xml2js');      // XML → JS

/* ───── tiny logger (console-based) ───── */
const LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const CURRENT = LEVELS[process.env.LOG_LEVEL] ?? LEVELS.info;
function log(level, ...args) {
  if (LEVELS[level] > CURRENT) return;
  console.log(`[${level.toUpperCase()}] ${new Date().toISOString()}`, ...args);
}
const logger = {
  error: (...a) => log('error', ...a),
  warn:  (...a) => log('warn',  ...a),
  info:  (...a) => log('info',  ...a),
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
const generateSlug = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
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

/* ───── property endpoints (NO hard-coded domains) ───── */
const propertyEndpoints = [
  {
    name: 'NOLANMAINS',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567452/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567452.xml',
    webflowApiKey: process.env.NOLANMAINS_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.NOLANMAINS_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.NOLANMAINS_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.NOLANMAINS_SITE_ID,
  },
  {
    name: 'ALVERA',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567445/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567445.xml',
    webflowApiKey: process.env.ALVERA_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.ALVERA_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.ALVERA_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.ALVERA_SITE_ID,
  },
  {
    name: 'ZENITH',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567457/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567457.xml',
    webflowApiKey: process.env.ZENITH_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.ZENITH_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.ZENITH_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.ZENITH_SITE_ID,
  },
  {
    name: 'THEWALKWAY',
    unitsUrl: 'https://www.on-site.com/web/api/properties/567456/units.xml',
    floorplansUrl: 'https://www.on-site.com/web/api/properties/567456.xml',
    webflowApiKey: process.env.THEWALKWAY_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.THEWALKWAY_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.THEWALKWAY_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.THEWALKWAY_SITE_ID,
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
    xml2js.parseString(xml, { explicitArray: false }, (err, res) => (err ? reject(err) : resolve(res)))
  );

/* ───── Webflow helpers ───── */
async function fetchAllWebflowData(collectionId, token, label, retry = 3) {
  if (!token) throw new Error(`Webflow token missing for ${label}`);
  if (!collectionId) throw new Error(`CollectionId missing for ${label}`);

  let items = [];
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(
      `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=100`,
      { headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' } }
    );
    if (!res.ok) {
      if (res.status === 429 && retry) {
        const wait = Number(res.headers.get('Retry-After') || 1);
        await new Promise(r => setTimeout(r, wait * 1000));
        retry--;
        continue;
      }
      const body = await res.text().catch(() => '');
      throw new Error(`Webflow GET ${res.status} for ${label} (collection ${collectionId}): ${body || '(no body)'}`);
    }
    const json = await res.json();
    const batch = json.items || [];
    items = items.concat(batch);
    if (batch.length < 100) break;
  }
  return items;
}

async function updateWebflowItem(id, collectionId, fieldData, token, label, retry = 3) {
  const res = await fetch(
    `https://api.webflow.com/v2/collections/${collectionId}/items/${id}`,
    {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ fieldData }),
    }
  );
  if (!res.ok) {
    if (res.status === 429 && retry) {
      const wait = Number(res.headers.get('Retry-After') || 1);
      await new Promise(r => setTimeout(r, wait * 1000));
      return updateWebflowItem(id, collectionId, fieldData, token, label, retry - 1);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`PATCH ${res.status} for ${label} (item ${id} in ${collectionId}): ${body || '(no body)'}`);
  }
  return true;
}

/* Fetch current custom-domain IDs at runtime */
async function getCustomDomainIds(siteId, token) {
  const res = await fetch(`https://api.webflow.com/v2/sites/${siteId}/custom_domains`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`domains ${res.status} for site ${siteId}: ${body || '(no body)'}`);
  }
  const { customDomains = [] } = await res.json();
  return customDomains.map(d => d.id);
}

/* Publish with auto-discovered domains (no hard-coded IDs) */
async function publishUpdates(siteId, token, opts = {}, label = '') {
  if (!token) throw new Error(`Webflow token missing for ${label}`);
  if (!siteId) throw new Error(`siteId missing for ${label}`);

  const publishWebflowSubdomain = opts.publishWebflowSubdomain !== false; // default true
  let customDomainIds = opts.customDomainIds; // 'AUTO' | string[] | undefined

  if (customDomainIds === 'AUTO' || customDomainIds == null) {
    try {
      customDomainIds = await getCustomDomainIds(siteId, token);
      logger.info(`[publish] ${label} domains: ${customDomainIds.length} found`);
    } catch (e) {
      logger.warn(`[publish] ${label} could not load custom domains: ${e.message}`);
      customDomainIds = [];
    }
  }

  const body = {
    publishToWebflowSubdomain: !!publishWebflowSubdomain,
    ...(Array.isArray(customDomainIds) && customDomainIds.length
      ? { customDomains: customDomainIds }
      : {}),
  };

  const res = await fetch(`https://api.webflow.com/v2/sites/${siteId}/publish`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Publish ${res.status} for ${label} (site ${siteId}): ${txt || '(no body)'}`);
  }
}

/* ───── processors ───── */
async function updateUnits(apartment, collectionId, items, token, label) {
  const avail = (apartment.availableUnits || []).map(u => u['apartment-num']?.toLowerCase());
  for (const unit of apartment.allUnits || []) {
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

    logger.info(`🏠 Updating unit ${slug} [${label}]`);
    await updateWebflowItem(item.id, collectionId, newData, token, `${label} unit ${slug}`);
  }
}

async function updateFloorPlans(apartment, collectionId, items, token, label) {
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

    logger.info(`🏢 Updating floorplan ${styleId} [${label}]`);
    await updateWebflowItem(item.id, collectionId, newData, token, `${label} floorplan ${styleId}`);
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
      const fpData = await parseXML(fpXML);
      const rawStyles = fpData?.property?.['unit-styles']?.['unit-style'] || [];

      result.push({
        property: p.name,
        allUnits: [].concat(unitsData?.units?.unit || []),
        availableUnits: [].concat(availData?.units?.unit || []),
        floorplans: [].concat(rawStyles || []),
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
    try {
      const labelApts = `${a.name} (apartments)`;
      const items = await fetchAllWebflowData(a.apartmentsCollectionId, a.webflowApiKey, labelApts);
      await updateUnits(a, a.apartmentsCollectionId, items, a.webflowApiKey, labelApts);

      if (a.property === 'ALVERA' && a.floorplansCollectionId) {
        const labelFPs = `${a.name} (floorplans)`;
        const fps = await fetchAllWebflowData(a.floorplansCollectionId, a.webflowApiKey, labelFPs);
        await updateFloorPlans(a, a.floorplansCollectionId, fps, a.webflowApiKey, labelFPs);
      }

      // Publish to Webflow subdomain + current custom domains (auto-discovered)
      await publishUpdates(
        a.siteId,
        a.webflowApiKey,
        { publishWebflowSubdomain: true, customDomainIds: 'AUTO' },
        a.name
      );
    } catch (err) {
      logger.error(`❌ Webflow update failed for ${a.name}:`, err.message);
    }
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

module.exports = { main };
// main(); // uncomment for local ad-hoc run
