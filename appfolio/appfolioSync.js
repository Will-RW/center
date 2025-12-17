/************************************************
 * appfolio/appfolioSync.js – AppFolio → Webflow
 *  • Crawls Nolan Mains AppFolio listings page (HTML)
 *  • Updates Webflow Units:
 *     - show-online
 *     - effective-rent-amount
 *     - original-rent-amount
 *     - available-date   (ISO string like On-Site, or null)
 *
 * Requires:
 *   npm i cheerio
 ************************************************/

require('dotenv').config();
const fetch = require('node-fetch');
const cheerio = require('cheerio');

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
logger.info('📣 AppFolio sync script booted');

/* ───── config ───── */
const APPFOLIO_URL =
  process.env.APPFOLIO_NOLANMAINS_URL ||
  'https://saturdayproperties.appfolio.com/listings/listings?filters[property_list]=nolan+mains';

const WEBFLOW_TOKEN = process.env.NOLANMAINS_WEBFLOW_API_KEY;
const COLLECTION_ID = process.env.NOLANMAINS_APARTMENTS_COLLECTION_ID;
const SITE_ID = process.env.NOLANMAINS_SITE_ID;

/* ───── utility helpers (match On-Site behavior) ───── */
const generateSlug = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '-');
const roundUp = n => (typeof n === 'number' ? Math.ceil(n) : n);

const logChanges = (oldData, newData) =>
  Object.keys(newData).reduce((arr, k) => {
    if (JSON.stringify(oldData[k]) !== JSON.stringify(newData[k])) {
      arr.push({ field: k, oldValue: oldData[k], newValue: newData[k] });
    }
    return arr;
  }, []);

function parseUnitFromAddress(address) {
  // From your HTML: "3945 Market Street Apt 206, Edina, MN 55424"
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

function parseAppfolioUsShortDateToISO(mdy) {
  // AppFolio shows "12/26/25" (MM/DD/YY)
  const t = String(mdy || '').trim();
  if (!t) return null;

  const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
  if (!m) return null;

  const mm = m[1].padStart(2, '0');
  const dd = m[2].padStart(2, '0');
  const yy = Number(m[3]);

  // Assume 20xx for 00-49, 19xx for 50-99 (safe + deterministic)
  const yyyy = yy < 50 ? `20${String(yy).padStart(2, '0')}` : `19${String(yy).padStart(2, '0')}`;

  // Match On-Site: store ISO string
  const iso = new Date(`${yyyy}-${mm}-${dd}T00:00:00Z`);
  return isNaN(iso) ? null : iso.toISOString();
}

/* ───── Webflow helpers (same pattern as On-Site) ───── */
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

/* ───── AppFolio HTML crawl + parse ───── */
async function fetchAppFolioUnits() {
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

  const map = new Map();

  $('.listing-item.result.js-listing-item').each((_, el) => {
    const $item = $(el);

    const address = $item.find('.js-listing-address').first().text().trim();
    const unit = parseUnitFromAddress(address);
    if (!unit) return;

    // Rent: find the quick-facts row whose label is RENT
    let rent = null;
    $item.find('.js-listing-quick-facts .detail-box__item').each((__, row) => {
      const label = $(row).find('.detail-box__label').text().trim().toUpperCase();
      if (label === 'RENT' && rent == null) {
        const rentText = $(row).find('.detail-box__value').text().trim();
        rent = parseMoneyToNumber(rentText);
      }
    });
    if (rent == null) return;

    // Available date: exists only sometimes
    const availText = $item
      .find('.js-listing-quick-facts .detail-box__value.js-listing-available')
      .first()
      .text()
      .trim();
    const availableIso = parseAppfolioUsShortDateToISO(availText); // ISO or null

    const slug = generateSlug(unit);
    map.set(slug, { unit, rent, availableIso, address });
  });

  logger.info(`✔︎ AppFolio parsed units: ${map.size}`);

  // helpful debug: show a couple parsed rows
  const sample = Array.from(map.entries()).slice(0, 3).map(([slug, v]) => ({ slug, ...v }));
  logger.debug('sample parsed units:', JSON.stringify(sample, null, 2));

  return map;
}

/* ───── processor: update Webflow ───── */
async function updateUnitsFromAppFolio(webflowItems, unitMap, token, collectionId, label) {
  for (const item of webflowItems) {
    const fields = item.fieldData || {};
    const slug = fields.slug;
    if (!slug) continue;

    const hit = unitMap.get(slug);

    if (hit) {
      const newData = {
        'available-date': hit.availableIso ?? null,
        'effective-rent-amount': roundUp(hit.rent),
        'original-rent-amount': roundUp(hit.rent),
        'show-online': true,
      };

      const changes = logChanges(fields, newData);
      if (!changes.length) continue;

      logger.info(`🏠 Updating unit ${slug} [${label}] → ${changes.map(c => c.field).join(', ')}`);
      await updateWebflowItem(item.id, collectionId, newData, token, `${label} unit ${slug}`);
      continue;
    }

    // Not present on AppFolio page => hide + clear date
    const newData = { 'show-online': false, 'available-date': null };
    const changes = logChanges(fields, newData);
    if (!changes.length) continue;

    logger.info(`🙈 Hiding unit ${slug} [${label}] → ${changes.map(c => c.field).join(', ')}`);
    await updateWebflowItem(item.id, collectionId, newData, token, `${label} unit ${slug}`);
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
