// rentcafe/framerSync.js
const express = require('express');
const axios = require('axios');
const router = express.Router();

/* ───────────────────────── Auth (Framer plugin) ───────────────────────── */
const FRAMER_SYNC_TOKEN = process.env.FRAMER_SYNC_TOKEN || '';
function requireBearer(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!FRAMER_SYNC_TOKEN || token !== FRAMER_SYNC_TOKEN) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

/* ───────────────────────── Property config (env-driven) ─────────────────────────
   For each property you want to sync to Framer, add ONE env var with its
   RentCafe "availability" endpoint (your proxy or direct API URL).

   Example for ERNESTINE:
   ERNESTINE_RENTCAFE_UNITS_URL=https://<your-proxy-or-rentcafe-api>/availability

   If the endpoint needs a Bearer token, set:
   ERNESTINE_RENTCAFE_BEARER=eyJhbGciOi...

   You can add more later (ALVERA, etc.) by duplicating the pattern below.
*/
function getPropertyConfig(property) {
  const key = String(property || '').toUpperCase();
  const url = process.env[`${key}_RENTCAFE_UNITS_URL`];
  const bearer = process.env[`${key}_RENTCAFE_BEARER`] || process.env.RENTCAFE_BEARER;
  return { url, bearer };
}

/* ───────────────────────── Normalization ─────────────────────────
   Input shape expected from your units URL is the common RentCafe/“apartmentAvailabilities”
   style you showed earlier (fields like apartmentName, floorplanName, minimumRent, maximumRent,
   unitStatus, availableDate "MM/DD/YYYY").

   We normalize to one item per UNIT with:
   - slug         : unit number (lowercased)
   - unitType     : floorplan/type code (string)
   - available    : boolean (derived from status)
   - availableDate: ISO string or ''
   - minRent/maxRent: numbers or null
   - updatedAt    : ISO (now if unknown)
*/
const YES_NO = b => (b ? 'YES' : 'NO');

function isAvailableStatus(status = '') {
  // Tweak if your statuses differ; this works with logs you shared.
  const s = String(status).toLowerCase();
  if (!s) return false;
  return (
    s.includes('vacant unrented') ||
    s.includes('notice unrented') ||
    s.includes('vacant') && !s.includes('rented') ||
    s === 'available'
  );
}

function parseUsDateToISO(mdy) {
  if (!mdy) return '';
  // supports 'MM/DD/YYYY'
  const [m, d, y] = String(mdy).split('/');
  if (!m || !d || !y) return '';
  const iso = new Date(`${y}-${m.padStart(2,'0')}-${d.padStart(2,'0')}T00:00:00Z`).toISOString();
  return iso;
}

function normalizeRentCafeUnits(property, raw) {
  const list =
    raw?.apartmentAvailabilities ||
    raw?.units ||
    [];

  const nowIso = new Date().toISOString();

  return list
    .map(u => ({
      slug: String(u.apartmentName ?? u.unitNumber ?? u.slug ?? '').trim().toLowerCase(), // e.g. "223"
      unitType: String(u.floorplanName ?? u.floorplanId ?? u.style ?? '').trim(),          // e.g. "S1"
      available: isAvailableStatus(u.unitStatus) || (typeof u.minimumRent === 'number' && u.minimumRent > 0),
      availableDate: u.availableDate ? parseUsDateToISO(u.availableDate) : '',
      minRent: typeof u.minimumRent === 'number' ? u.minimumRent : null,
      maxRent: typeof u.maximumRent === 'number' ? u.maximumRent : null,
      updatedAt: nowIso,
    }))
    .filter(u => u.slug); // must have a unit number
}

/* Mark exactly ONE “Featured = YES” per unitType among available units:
   pick the lowest minRent; tie-breaker earliest availableDate; final tie-breaker slug. */
function applyFeaturedFlags(units) {
  const byType = new Map();
  for (const u of units) {
    if (!u.unitType) continue;
    if (!byType.has(u.unitType)) byType.set(u.unitType, []);
    byType.get(u.unitType).push(u);
  }
  for (const u of units) u._featured = false;

  for (const [, arr] of byType) {
    const avail = arr.filter(x => x.available);
    if (!avail.length) continue;
    avail.sort((a, b) => {
      const ar = a.minRent ?? Infinity, br = b.minRent ?? Infinity;
      if (ar !== br) return ar - br;
      const ad = a.availableDate ? Date.parse(a.availableDate) : Infinity;
      const bd = b.availableDate ? Date.parse(b.availableDate) : Infinity;
      if (ad !== bd) return ad - bd;
      return String(a.slug).localeCompare(String(b.slug));
    });
    avail[0]._featured = true;
  }
}

/* Build Framer CMS Data Sync items (upsert by slug) */
function buildFramerItems(property, units, sinceIso) {
  const since = sinceIso ? Date.parse(sinceIso) : null;
  const nowIso = new Date().toISOString();

  const items = units.map(u => ({
    externalId: `${property.toLowerCase()}::unit::${u.slug}`,
    slug: u.slug,
    fields: {
      'Available': YES_NO(!!u.available),
      'Available Date': u.availableDate || '',
      'Minimum Rent': typeof u.minRent === 'number' ? u.minRent : null,
      'Maximum Rent': typeof u.maxRent === 'number' ? u.maxRent : null,
      'Featured': YES_NO(!!u._featured),
    },
    updatedAt: u.updatedAt || nowIso,
  }));

  return since ? items.filter(i => Date.parse(i.updatedAt) > since) : items;
}

/* Fetch units JSON from the configured URL (per property) */
async function fetchUnitsForProperty(property) {
  const { url, bearer } = getPropertyConfig(property);
  if (!url) throw new Error(`Missing env URL for ${property}: ${property}_RENTCAFE_UNITS_URL`);

  const headers = { Accept: 'application/json' };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const { data } = await axios.get(url, { headers, timeout: 15000 });
  return data;
}

/* ───────────────────────── Routes for Framer CMS Data Sync ─────────────────────────
   Bulk:   GET /framer/cms-sync/:property/units?since=ISO
   Single: GET /framer/cms-sync/:property/unit/:slug
*/
router.get('/framer/cms-sync/:property/units', requireBearer, async (req, res) => {
  try {
    const property = String(req.params.property || '').toUpperCase(); // e.g. ERNESTINE
    const since = req.query.since ? String(req.query.since) : undefined;

    const raw = await fetchUnitsForProperty(property);
    const units = normalizeRentCafeUnits(property, raw);
    applyFeaturedFlags(units);
    const items = buildFramerItems(property, units, since);

    res.json({ property, total: units.length, changed: items.length, items, generatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[framer-sync] bulk error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'cms_sync_failed' });
  }
});

router.get('/framer/cms-sync/:property/unit/:slug', requireBearer, async (req, res) => {
  try {
    const property = String(req.params.property || '').toUpperCase();
    const slug = String(req.params.slug || '').toLowerCase();

    const raw = await fetchUnitsForProperty(property);
    const units = normalizeRentCafeUnits(property, raw);
    applyFeaturedFlags(units);

    const u = units.find(x => String(x.slug).toLowerCase() === slug);
    if (!u) return res.status(404).json({ error: 'not_found' });

    const [item] = buildFramerItems(property, [u]);
    res.json(item);
  } catch (err) {
    console.error('[framer-sync] single error:', err?.response?.data || err.message);
    res.status(500).json({ error: 'cms_sync_failed' });
  }
});

module.exports = router;
