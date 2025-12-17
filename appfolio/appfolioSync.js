/************************************************
 * appfolio/appfolioSync.js – AppFolio → Webflow
 * Syncs Nolan Mains AppFolio listings page to Webflow Units:
 *  - show-online (present on page => true, else false)
 *  - effective-rent-amount + original-rent-amount (from AppFolio RENT)
 *  - available-date (from AppFolio "Available" MM/DD/YY; null if missing)
 *
 * Requires: npm i cheerio
 ************************************************/

require('dotenv').config();
const fetch = require('node-fetch');
const cheerio = require('cheerio');

/* -------------------- logger -------------------- */
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

/* -------------------- config -------------------- */
const APPFOLIO_URL =
  process.env.APPFOLIO_NOLANMAINS_URL ||
  'https://saturdayproperties.appfolio.com/listings/listings?filters[property_list]=nolan+mains';

const WEBFLOW_TOKEN = process.env.NOLANMAINS_WEBFLOW_API_KEY;
const COLLECTION_ID = process.env.NOLANMAINS_APARTMENTS_COLLECTION_ID;
const SITE_ID = process.env.NOLANMAINS_SITE_ID;

/* -------------------- helpers -------------------- */
const generateSlug = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');

function roundUp(n) {
  return typeof n === 'number' ? Math.ceil(n) : n;
}

function parseUnitFromAddress(address) {
  // deterministic from your HTML: "... Apt 322, ..."
  const m = String(address || '').match(/\bApt[-\s]*([A-Za-z0-9]+)\b/);
  return m ? m[1] : null;
}

function parseMoneyToNumber(text) {
  // "$5,995" => 5995
  const m = String(text || '').match(/\$([\d,]+)/);
  if (!m) return null;
  const n = Number(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

function parseAvailableDate(text) {
  // "12/26/25" => Date(2025-12-26 local)
  const t = String(text || '').trim();
  if (!t) return null;

  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;

  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yy = Number(m[3]);
  if (!mm || !dd || Number.isNaN(yy)) return null;

  const fullYear = yy < 50 ? 2000 + yy : 1900 + yy;
  const d = new Date(fullYear, mm - 1, dd);
  return Number.isNaN(d.getTime()) ? null : d;
}

function logChanges(oldData, newData) {
  return Object.keys(newData).reduce((arr, k) => {
    if (JSON.stringify(oldData[k]) !== JSON.stringify(newData[k])) {
      arr.push({ field: k, oldValue: oldData[k], newValue: newData[k] });
    }
    return arr;
  }, []);
}

/* -------------------- Webflow helpers -------------------- */
async function fetchAllWebflowData(collectionId, token, label, retry = 3) {
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
      throw new Error(`Webflow GET ${res.status} for ${label}: ${body || '(no body)'}`);
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
    throw new Error(`PATCH ${res.status} for ${label} (item ${id}): ${body || '(no body)'}`);
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
  const publishWebflowSubdomain = opts.publishWebflowSubdomain !== false;
  let customDomainIds = opts.customDomainIds;

  if (customDomainIds === 'AUTO' || customDomainIds == null) {
    customDomainIds = await getCustomDomainIds(siteId, token).catch(() => []);
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

/* -------------------- AppFolio crawl + parse -------------------- */
async function fetchAppFolioUnitsFromHtml() {
  logger.info(`🔄 Fetching AppFolio listings HTML: ${APPFOLIO_URL}`);

  const res = await fetch(APPFOLIO_URL, {
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36',
      Accept: 'text/html',
    },
  });

  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`AppFolio GET ${res.status}: ${txt || '(no body)'}`);
  }

  const html = await res.text();
  const $ = cheerio.load(html);

  // deterministic based on your source:
  // <div class="listing-item result js-listing-item" ...>
  const unitMap = new Map();

  $('.listing-item.result.js-listing-item').each((_, el) => {
    const $item = $(el);

    const address = $item.find('.js-listing-address').first().text().trim();
    const unit = parseUnitFromAddress(address);
    if (!unit) return;

    // Rent: inside quick-facts box, first RENT dd
    let rent = null;
    $item.find('.js-listing-quick-facts .detail-box__item').each((__, boxEl) => {
      const label = $(boxEl).find('.detail-box__label').text().trim().toUpperCase();
      if (label === 'RENT' && rent == null) {
        const rentText = $(boxEl).find('.detail-box__value').text().trim();
        rent = parseMoneyToNumber(rentText);
      }
    });

    // Available date: <dd class="detail-box__value js-listing-available">12/26/25</dd>
    // (may not exist; if missing => null)
    const availText = $item
      .find('.js-listing-quick-facts .detail-box__value.js-listing-available')
      .first()
      .text()
      .trim();
    const availableDate = parseAvailableDate(availText);

    if (rent == null) return;

    const slug = generateSlug(unit);
    unitMap.set(slug, { unit, rent, availableDate, address });
  });

  logger.info(`✔︎ AppFolio parsed units: ${unitMap.size}`);
  return unitMap;
}

/* -------------------- Apply AppFolio -> Webflow -------------------- */
async function updateUnitsFromAppFolio(webflowItems, unitMap) {
  for (const item of webflowItems) {
    const fields = item.fieldData || {};
    const slug = fields.slug;
    if (!slug) continue;

    const hit = unitMap.get(slug);

    if (hit) {
      const newData = {
        'show-online': true,
        'effective-rent-amount': roundUp(hit.rent),
        'original-rent-amount': roundUp(hit.rent),
        'available-date': hit.availableDate ?? null,
      };

      if (!logChanges(fields, newData).length) continue;

      logger.info(`🏠 Updating unit ${slug} (AppFolio present)`);
      await updateWebflowItem(item.id, COLLECTION_ID, newData, WEBFLOW_TOKEN, `unit ${slug}`);
      continue;
    }

    // Not present on AppFolio page => hide + clear available-date
    // Only update if it would actually change something
    const newData = { 'show-online': false, 'available-date': null };
    if (!logChanges(fields, newData).length) continue;

    logger.info(`🙈 Hiding unit ${slug} (not on AppFolio page)`);
    await updateWebflowItem(item.id, COLLECTION_ID, newData, WEBFLOW_TOKEN, `unit ${slug}`);
  }
}

/* -------------------- main job -------------------- */
async function main() {
  const label = 'NOLANMAINS (AppFolio)';

  if (!WEBFLOW_TOKEN) throw new Error('Missing env: NOLANMAINS_WEBFLOW_API_KEY');
  if (!COLLECTION_ID) throw new Error('Missing env: NOLANMAINS_APARTMENTS_COLLECTION_ID');
  if (!SITE_ID) throw new Error('Missing env: NOLANMAINS_SITE_ID');

  logger.info(`▶︎ AppFolio sync start [${label}]`);

  const unitMap = await fetchAppFolioUnitsFromHtml();
  const webflowItems = await fetchAllWebflowData(COLLECTION_ID, WEBFLOW_TOKEN, label);

  await updateUnitsFromAppFolio(webflowItems, unitMap);

  await publishUpdates(
    SITE_ID,
    WEBFLOW_TOKEN,
    { publishWebflowSubdomain: true, customDomainIds: 'AUTO' },
    label
  );

  logger.info(`✔︎ AppFolio sync done [${label}]`);
}

module.exports = { main };
