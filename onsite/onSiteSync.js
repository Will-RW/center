/************************************************
 * onSiteSync.js (Updated Version)
 ************************************************/

const fetch = require("node-fetch");
const axios = require("axios");
const xml2js = require("xml2js");
const cron = require("node-cron");
const config = require("./config");
const logger = require("./utils/logger");
const {
  convertNumber,
  convertBoolean,
  convertDate,
  generateSlug,
} = require("./utils/utils");

const API_USERNAME = config.onSite.username;
const API_PASSWORD = config.onSite.password;

/**
 * Property endpoints define the "units" and "floorplans" XML feeds for each
 * property, plus the necessary Webflow collection IDs and site info.
 */
const propertyEndpoints = [
  {
    name: "NOLANMAINS",
    unitsUrl: "https://www.on-site.com/web/api/properties/567452/units.xml",
    floorplansUrl: "https://www.on-site.com/web/api/properties/567452.xml",
    webflowApiKey: process.env.NOLANMAINS_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.NOLANMAINS_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.NOLANMAINS_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.NOLANMAINS_SITE_ID,
    customDomains: ["66db288b0e91e910a34cb876"],
  },
  {
    name: "ALVERA",
    unitsUrl: "https://www.on-site.com/web/api/properties/567445/units.xml",
    floorplansUrl: "https://www.on-site.com/web/api/properties/567445.xml",
    webflowApiKey: process.env.ALVERA_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.ALVERA_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.ALVERA_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.ALVERA_SITE_ID,
    customDomains: ["62edf2bf53f04db521620dfb"],
  },
  {
    name: "ZENITH",
    unitsUrl: "https://www.on-site.com/web/api/properties/567457/units.xml",
    floorplansUrl: "https://www.on-site.com/web/api/properties/567457.xml",
    webflowApiKey: process.env.ZENITH_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.ZENITH_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.ZENITH_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.ZENITH_SITE_ID,
    customDomains: ["67225edaa64d92c89b25556f"],
  },
  {
    name: "THEWALKWAY",
    unitsUrl: "https://www.on-site.com/web/api/properties/567456/units.xml",
    floorplansUrl: "https://www.on-site.com/web/api/properties/567456.xml",
    webflowApiKey: process.env.THEWALKWAY_WEBFLOW_API_KEY,
    apartmentsCollectionId: process.env.THEWALKWAY_APARTMENTS_COLLECTION_ID,
    floorplansCollectionId: process.env.THEWALKWAY_FLOORPLANS_COLLECTION_ID,
    siteId: process.env.THEWALKWAY_SITE_ID,
    customDomains: ["623532ef11b2ba7054bbca19"],
  },
];

/**
 * Fetch XML from OnSite with Basic Auth, returning the raw XML text.
 */
async function fetchXML(url) {
  logger.info(`Fetching XML from URL: ${url}`);
  try {
    const response = await axios.get(url, {
      auth: {
        username: API_USERNAME,
        password: API_PASSWORD,
      },
      responseType: "text",
    });
    logger.debug(`Received response for URL: ${url}`);
    return response.data;
  } catch (error) {
    logger.error(`Error fetching XML from URL: ${url}`, error);
    throw error;
  }
}

/**
 * Parse raw XML string into JS object using xml2js.
 */
async function parseXML(xml) {
  logger.debug("Parsing XML data");
  return new Promise((resolve, reject) => {
    xml2js.parseString(xml, { explicitArray: false }, (err, result) => {
      if (err) {
        logger.error("Error parsing XML:", err);
        reject(err);
      } else {
        logger.debug("XML parsed successfully");
        resolve(result);
      }
    });
  });
}

/**
 * Fetch all items in a given Webflow collection, respecting pagination (100 items at a time).
 */
async function fetchAllWebflowData(collectionId, webflowApiKey, retryCount = 3) {
  logger.info(`Fetching all Webflow data for collection ID: ${collectionId}`);
  let items = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    try {
      const response = await fetch(
        `https://api.webflow.com/v2/collections/${collectionId}/items?offset=${offset}&limit=${limit}`,
        {
          headers: {
            Authorization: `Bearer ${webflowApiKey}`,
            accept: "application/json",
          },
        }
      );

      if (!response.ok) {
        if (response.status === 429 && retryCount > 0) {
          const retryAfter = response.headers.get("Retry-After") || 1;
          logger.warn(`Rate limited. Retrying after ${retryAfter} seconds...`);
          await new Promise((resolve) =>
            setTimeout(resolve, retryAfter * 1000)
          );
          return fetchAllWebflowData(collectionId, webflowApiKey, retryCount - 1);
        } else {
          throw new Error(
            `Failed to fetch Webflow data: ${response.statusText}`
          );
        }
      }

      const data = await response.json();
      items = items.concat(data.items);
      logger.debug(`Fetched ${data.items.length} items from Webflow`);

      if (data.items.length < limit) {
        break;
      }
      offset += limit;
    } catch (error) {
      logger.error(`Error fetching Webflow data:`, error.message);
      return items;
    }
  }

  logger.info(`Completed fetching Webflow data for collection ID: ${collectionId}`);
  return items;
}

/**
 * Compare existing vs. new data and return an array describing changed fields.
 */
function logChanges(oldData, newData) {
  const changes = [];
  for (const key in newData) {
    if (!Object.prototype.hasOwnProperty.call(newData, key)) continue;

    const oldValue = Object.prototype.hasOwnProperty.call(oldData, key)
      ? oldData[key]
      : undefined;
    const newValue = newData[key];

    // Special handling for date fields
    if (key === "available-date") {
      if (!oldValue && !newValue) continue;
      if (oldValue !== newValue) {
        changes.push({
          field: key,
          oldValue: oldValue || "undefined",
          newValue: newValue || "null",
        });
      }
    } else if (JSON.stringify(newValue) !== JSON.stringify(oldValue)) {
      changes.push({ field: key, oldValue, newValue });
    }
  }
  return changes;
}

/**
 * Make a PATCH request to update a single Webflow CMS item.
 */
async function updateWebflowItem(
  itemId,
  collectionId,
  newData,
  webflowApiKey,
  retryCount = 3
) {
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/${itemId}`;
  logger.info(`Updating Webflow item with ID: ${itemId} in collection: ${collectionId}`);

  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${webflowApiKey}`,
        accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ fieldData: newData }),
    });

    const responseData = await response.json();
    logger.info(`API response: ${JSON.stringify(responseData, null, 2)}`);

    if (!response.ok) {
      if (response.status === 429 && retryCount > 0) {
        const retryAfter = response.headers.get("Retry-After") || 1;
        logger.warn(`Rate limited. Retrying after ${retryAfter} seconds...`);
        await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
        return updateWebflowItem(
          itemId,
          collectionId,
          newData,
          webflowApiKey,
          retryCount - 1
        );
      } else {
        throw new Error(`Failed to update Webflow item: ${response.statusText}`);
      }
    }

    return true;
  } catch (error) {
    logger.error(`Error updating Webflow item with ID: ${itemId}:`, error.message);
    logger.error(`Error stack:`, error.stack);
    return false;
  }
}

/**
 * Extract string from <style-id> if it's an object.
 */
function getStyleIdValue(styleIdField) {
  if (styleIdField && typeof styleIdField === "object") {
    return styleIdField._;
  }
  return styleIdField;
}

/**
 * Round up float to integer (e.g. 8325.85 => 8326).
 */
function roundUp(num) {
  if (typeof num === "number") {
    return Math.ceil(num);
  }
  return num;
}

/**
 * Convert min/max rent from possibly nested object to number or 0.
 */
function parseRent(value) {
  // 1) If it's an object with `_`, extract that
  if (value && typeof value === "object" && value._) {
    value = value._; 
  }
  // 2) If it's still an object after that, just return 0
  //    (rather than passing "[object Object]" to convertNumber)
  if (value && typeof value === "object") {
    return 0;
  }
  // 3) Now it's a string or undefined/null. Let convertNumber handle it
  const num = convertNumber(value);
  return typeof num === "number" ? num : 0; 
}

/**
 * Update "units", rounding up rents, only logs if changes are found.
 */
async function updateUnits(apartment, collectionId, items, webflowApiKey) {
  logger.info(`🔄 Updating Webflow units for property: ${apartment.property}`);

  const allUnits = Array.isArray(apartment.allUnits) ? apartment.allUnits : [];
  const availableUnits = Array.isArray(apartment.availableUnits)
    ? apartment.availableUnits.map((unit) =>
        unit && unit["apartment-num"] ? unit["apartment-num"].toLowerCase() : null
      )
    : [];

  logger.debug(`📌 All units for ${apartment.property}: ${JSON.stringify(allUnits)}`);
  logger.debug(`✅ Available units: ${JSON.stringify(availableUnits)}`);

  for (const unit of allUnits) {
    if (!unit["apartment-num"]) continue; // skip if missing

    const slug = generateSlug(unit["apartment-num"]);
    const matchingItem = items.find((item) => item.fieldData.slug === slug);
    if (!matchingItem) continue; // skip silently

    // Round up rent
    const rawEffective = convertNumber(unit["effective-rent-amount"]);
    const rawOriginal = convertNumber(unit["rent-amount"]);
    const effectiveRent = roundUp(rawEffective);
    const originalRent = roundUp(rawOriginal);

    const newData = {
      "available-date": convertDate(unit["available-date"]),
      "effective-rent-amount": effectiveRent,
      "original-rent-amount": originalRent,
      "show-online": convertBoolean(
        availableUnits.includes(unit["apartment-num"].toLowerCase())
      ),
    };

    const changes = logChanges(matchingItem.fieldData, newData);
    if (!changes.length) {
      // No changes => skip
      continue;
    }

    logger.info(
      `🏠 Unit ${slug} | Effective Rent: ${effectiveRent}, Original Rent: ${originalRent}`
    );
    logger.info(`🚀 Updating unit ${slug} in Webflow...`);

    const updateSuccess = await updateWebflowItem(
      matchingItem.id,
      collectionId,
      newData,
      webflowApiKey
    );

    if (updateSuccess) {
      logger.info(`✅ Successfully updated unit ${slug} in Webflow`);
    } else {
      logger.error(`❌ Failed to update unit ${slug}`);
    }
  }
}

/**
 * Update "floor plans" for ALVERA, using parseRent for min/max rent,
 * only logging on changes, skipping silently otherwise.
 */
async function updateFloorPlans(apartment, collectionId, items, webflowApiKey) {
  logger.info(`Updating Webflow floor plans for property: ${apartment.property}`);

  const allFloorPlans = apartment.floorplans || [];
  if (!allFloorPlans.length) {
    // no floor plans => skip
    return;
  }

  for (const floorplan of allFloorPlans) {
    const styleId = String(getStyleIdValue(floorplan["style-id"]) || "");
    if (!styleId) continue; // skip if invalid

    const matchingItem = items.find((item) => item.fieldData.slug === styleId);
    if (!matchingItem) continue; // skip silently

    // Parse min-rent/max-rent as numbers or 0
    const minRent = parseRent(floorplan["min-rent"]);
    const maxRent = parseRent(floorplan["max-rent"]);
    const availableUnits = convertNumber(floorplan["num-available"]) || 0;

    const newData = {
      "minimum-rent": minRent,
      "maximum-rent": maxRent,
      "available-units-count": availableUnits,
    };

    const changes = logChanges(matchingItem.fieldData, newData);
    if (!changes.length) {
      // no changes => skip
      continue;
    }

    logger.info(
      `🏠 Floor Plan ${styleId} | Min Rent: ${minRent}, Max Rent: ${maxRent}, Available Units: ${availableUnits}`
    );
    logger.info(`🚀 Updating floor plan ${styleId} in Webflow...`);

    const updateSuccess = await updateWebflowItem(
      matchingItem.id,
      collectionId,
      newData,
      webflowApiKey
    );

    if (updateSuccess) {
      logger.info(`✅ Successfully updated floor plan ${styleId} in Webflow`);
    } else {
      logger.error(`❌ Failed to update floor plan ${styleId}`);
    }
  }
}

/**
 * Main logic: fetch data, update units, update floor plans if ALVERA, then publish.
 */
async function updateWebflowCollections(apartments) {
  for (const apartment of apartments) {
    logger.info(`Updating Webflow collections for property: ${apartment.property}`);

    // 1) Units
    const apartmentItems = await fetchAllWebflowData(
      apartment.apartmentsCollectionId,
      apartment.webflowApiKey
    );
    await updateUnits(
      apartment,
      apartment.apartmentsCollectionId,
      apartmentItems,
      apartment.webflowApiKey
    );

    // 2) If ALVERA, floor plans
    if (apartment.property === "ALVERA" && apartment.floorplansCollectionId) {
      logger.info("Floor plan updates apply only to ALVERA. Proceeding...");
      const floorplanItems = await fetchAllWebflowData(
        apartment.floorplansCollectionId,
        apartment.webflowApiKey
      );
      await updateFloorPlans(
        apartment,
        apartment.floorplansCollectionId,
        floorplanItems,
        apartment.webflowApiKey
      );
    } else {
      logger.info(
        `Skipping floor plan updates for ${apartment.property}.`
      );
    }

    // 3) Publish
    const propertyConfig = propertyEndpoints.find(
      (p) => p.name === apartment.property
    );
    if (!propertyConfig || !propertyConfig.customDomains) {
      logger.error(`Error: customDomains is undefined for ${apartment.property}`);
    } else {
      logger.info(`Publishing updates for ${apartment.property}`);
      logger.info(
        `Domains being passed for ${apartment.property}: ${JSON.stringify(
          propertyConfig.customDomains
        )}`
      );
      await publishUpdates(
        apartment.siteId,
        apartment.webflowApiKey,
        propertyConfig.customDomains
      );
    }

    logger.info(`Finished updates for property: ${apartment.property}`);
  }
}

/**
 * Fetch data from OnSite for each property.
 */
async function fetchApartmentData() {
  logger.info("Fetching apartment data from OnSite");
  let apartments = [];
  for (const property of propertyEndpoints) {
    try {
      logger.info(`Processing property: ${property.name}`);

      const unitsXML = await fetchXML(property.unitsUrl);
      const unitsData = await parseXML(unitsXML);

      const availableUnitsXML = await fetchXML(
        `${property.unitsUrl}?available_only=true`
      );
      const availableUnitsData = await parseXML(availableUnitsXML);

      const floorplansXML = await fetchXML(property.floorplansUrl);
      const floorplansData = await parseXML(floorplansXML);

      const rawUnitStyles =
        floorplansData?.property?.["unit-styles"]?.["unit-style"];
      const floorplans = rawUnitStyles
        ? Array.isArray(rawUnitStyles)
          ? rawUnitStyles
          : [rawUnitStyles]
        : [];

      apartments.push({
        property: property.name,
        allUnits: Array.isArray(unitsData.units.unit)
          ? unitsData.units.unit
          : [unitsData.units.unit],
        availableUnits: Array.isArray(availableUnitsData.units.unit)
          ? availableUnitsData.units.unit
          : [availableUnitsData.units.unit],
        floorplans,
        webflowApiKey: property.webflowApiKey,
        apartmentsCollectionId: property.apartmentsCollectionId,
        floorplansCollectionId: property.floorplansCollectionId,
        siteId: property.siteId,
      });

      logger.info(`Successfully fetched data for property: ${property.name}`);
    } catch (error) {
      logger.error(`Error processing property ${property.name}: ${error.message}`);
    }
  }
  return apartments;
}

/**
 * Publish updates to a given Webflow site.
 */
async function publishUpdates(siteId, webflowApiKey, customDomainIds = []) {
  logger.info(`Publishing updates for site ${siteId}`);
  logger.info(`Custom domains being passed: ${JSON.stringify(customDomainIds)}`);

  const url = `https://api.webflow.com/v2/sites/${siteId}/publish`;

  const options = {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      authorization: `Bearer ${webflowApiKey}`,
    },
    body: JSON.stringify({
      publishToWebflowSubdomain: true,
      customDomains: customDomainIds,
    }),
  };

  try {
    const response = await fetch(url, options);
    const responseText = await response.text();
    logger.info(`Full API response: ${responseText}`);

    if (!response.ok) {
      logger.error(`Failed to publish updates: ${response.statusText}. Body: ${responseText}`);
      throw new Error(`Error during publishing: ${responseText}`);
    }

    logger.info(`Updates published successfully to custom domains and subdomain for site ${siteId}`);
  } catch (error) {
    logger.error(`Error publishing updates for site ${siteId}: ${error.message}`);
    throw error;
  }
}

/**
 * The main function that runs everything.
 */
async function main() {
  logger.info("Starting main function");

  try {
    const apartments = await fetchApartmentData();
    await updateWebflowCollections(apartments);
    logger.info("Main function completed successfully");
  } catch (error) {
    logger.error(`Error in main process: ${error.message}`);
  }
}

// Cron job every 15 minutes
cron.schedule("*/15 * * * *", () => {
  logger.info("Cron job triggered");
  main();
});

// Uncomment to run immediately
 //main();
