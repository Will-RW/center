/************************************************
 * appfolio/appfolioSync.js – AppFolio → Webflow
 *  • Leaves On-Site code untouched
 *  • Crawls Nolan Mains AppFolio listings page
 *  • Updates: show-online + rent fields only
 ************************************************/

const fetch = require('node-fetch');   // Webflow API (v2) + AppFolio HTML fetch
const axios = require('axios');        // optional (kept consistent with repo)
require('dotenv').config();

/* ───── tiny logger (same style as onsite) ───── */
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
logger.info('📣 AppFolio sync script booted');

/* ───── config ───── */
const APPFOLIO_URL =
  process.env.APPFOLIO_NOLANMAINS_URL ||
  'https://saturdayproperties.appfolio.com/listings/listings?filters[property_list]=nolan+mains';

const WEBFLOW_TOKEN = process.env.NOLANMAINS_WEBFLOW_API_KEY;
const COLLECTION_ID = process.env.NOLANMAINS_APARTMENTS_COLLECTION_ID;
const SITE_ID = process.env.NOLANMAINS_SITE_ID;

/* ───── utility helpers (copied from onsite patterns) ───── */
const generateSlug = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
const convertNumber = v => {
  if (typeof v === 'string') v = v.replace(/[^0-9.\-]+/g, '');
  const n = parseFloat(v);
  return isNaN(n) ? null : n;
};
const roundUp = n => (typeof n === 'number' ? Math.ceil(n) : n);
const logChanges = (oldData, newData) =>
  Object.keys(newData).reduce((arr, k) => {
    if (JSON.stringify(oldData[k]) !== JSON.stringify(newData[k])) {
      arr.push({ field: k, oldValue: oldData[k], newValue: newData[k] });
    }
    return arr;
  }, []);

/* ───── Webflow helpers (same as onsite/onSiteSync.js) ───── */
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

async function publishUpdates(siteId, token, opts = {}, label = '') {
  if (!token) throw new Error(`Webflow token missing for ${label}`);
  if (!siteId) throw new Error(`siteId missing for ${label}`);

  const publishWebflowSubdomain = opts.publishWebflowSubdomain !== false;
  let customDomainIds = opts.customDomainIds;

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
    ...(Array.isArray(customDomainIds) && customDomainIds.length ? { customDomains: customDomainIds } : {}),
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

/* ───── AppFolio parser: extract markers array from HTML ───── */
function extractMarkersArrayFromHtml(html) {
  const markersKey = 'markers:';
  const idx = html.indexOf(markersKey);
  if (idx === -1) return null;

  const start = html.indexOf('[', idx);
  if (start === -1) return null;

  let depth = 0;
  let end = -1;
  for (let i = start; i < html.length; i++) {
    const ch = html[i];
    if (ch === '[') depth++;
    else if (ch === ']') {
      depth--;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end === -1) return null;

  const arrayText = html.slice(start, end + 1);
  return JSON.parse(arrayText);
}

function parseUnitFromAddress(address) {
  // deterministic for your sample HTML: " ... Apt 322, ..."
  const m = String(address || '').match(/\bApt[-\s]*([A-Za-z0-9]+)\b/);
  return m ? m[1] : null;
}

function parseRentToNumber(rentRange) {
  const m = String(rentRange || '').match(/\$([\d,]+)/);
  if (!m) return null;
  return Number(m[1].replace(/,/g, ''));
}

async function fetchAppFolioUnits() {
  logger.info(`🔄 Fetching AppFolio listings HTML: ${APPFOLIO_URL}`);

  const res = await fetch(APPFOLIO_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      Accept: 'text/html',
    }
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`AppFolio GET ${res.status}: ${txt || '(no body)'}`);
  }

  const html = await res.text();
  const markers = extractMarkersArrayFromHtml(html);
  if (!Array.isArray(markers)) {
    throw new Error('Could not parse AppFolio embedded markers array (page structure changed).');
  }

  // Build map: slug(unit) -> { unit, rent }
  const map = new Map();
  for (const m of markers) {
    const unit = parseUnitFromAddress(m.address);
    const rent = parseRentToNumber(m.rent_range);
    if (!unit || !rent) continue;

    const slug = generateSlug(unit);
    map.set(slug, { unit, rent, address: m.address, listingId: m.listing_id });
  }

  logger.info(`✔︎ AppFolio parsed units: ${map.size}`);
  return map;
}

/* ───── processor: update Webflow using AppFolio presence+rent ───── */
async function updateUnitsFromAppFolio(webflowItems, unitMap, token, collectionId, label) {
  for (const item of webflowItems) {
    const fields = item.fieldData || {};
    const slug = fields.slug;
    if (!slug) continue;

    const hit = unitMap.get(slug);

    // present on AppFolio page => show-online true and rent updated
    if (hit) {
      const newData = {
        'show-online': true,
        'effective-rent-amount': roundUp(hit.rent),
        'original-rent-amount': roundUp(hit.rent),
      };

      if (!logChanges(fields, newData).length) continue;

      logger.info(`🏠 Updating unit ${slug} [${label}] (AppFolio present)`);
      await updateWebflowItem(item.id, collectionId, newData, token, `${label} unit ${slug}`);
      continue;
    }

    // NOT present on AppFolio page => show-online false (only if currently true to reduce writes)
    if (fields['show-online'] === true) {
      const newData = { 'show-online': false };
      logger.info(`🙈 Hiding unit ${slug} [${label}] (not on AppFolio page)`);
      await updateWebflowItem(item.id, collectionId, newData, token, `${label} unit ${slug}`);
    }
  }
}

/* ───── orchestration ───── */
async function main() {
  const label = 'NOLANMAINS (AppFolio)';
  try {
    if (!WEBFLOW_TOKEN) throw new Error('Missing env: NOLANMAINS_WEBFLOW_API_KEY');
    if (!COLLECTION_ID) throw new Error('Missing env: NOLANMAINS_APARTMENTS_COLLECTION_ID');
    if (!SITE_ID) throw new Error('Missing env: NOLANMAINS_SITE_ID');

    logger.info(`▶︎ AppFolio sync start [${label}]`);
    const unitMap = await fetchAppFolioUnits();
    const webflowItems = await fetchAllWebflowData(COLLECTION_ID, WEBFLOW_TOKEN, label);

    await updateUnitsFromAppFolio(webflowItems, unitMap, WEBFLOW_TOKEN, COLLECTION_ID, label);

    await publishUpdates(
      SITE_ID,
      WEBFLOW_TOKEN,
      { publishWebflowSubdomain: true, customDomainIds: 'AUTO' },
      label
    );

    logger.info(`✔︎ AppFolio sync done [${label}]`);
  } catch (err) {
    logger.error(`❌ AppFolio sync failed [${label}]:`, err.message);
  }
}

module.exports = { main };
// main(); // uncomment for local ad-hoc run
