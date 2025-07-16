const { updateWebflowItemsLive } = require("./webflow"); // Batch update function
require("dotenv").config();

/**
 * Helper function to ensure slug is valid:
 * - Lowercase
 * - Remove non-alphanumeric or hyphens
 * - Replace spaces with hyphens
 * - Limit to 64 chars
 */
function sanitizeSlug(str = "") {
  return str
    .toLowerCase()
    .replace(/[^\w-]+/g, "")
    .replace(/\s+/g, "-")
    .substring(0, 64);
}

/**
 * Normalize date to ISO 8601
 */
function normalizeDate(date) {
  if (!date) return null;
  const [mm, dd, yyyy] = date.split("/");
  if (!mm || !dd || !yyyy) return null;
  return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}T00:00:00.000Z`;
}

/**
 * Sync RentCafe data with Webflow data
 * @param {Array} rentCafeData - RentCafe apartment data
 * @param {Array} webflowData - Webflow collection items
 * @param {string} webflowToken - Webflow API token
 * @param {string} collectionId - Webflow collection ID
 */
async function syncWithWebflow(rentCafeData, webflowData, webflowToken, collectionId) {
  const rentCafeMap = {};
  const itemsToUpdate = [];

  // Map RentCafe data by apartment name
  rentCafeData.forEach((apt) => {
    rentCafeMap[apt.apartmentName] = apt;
  });

  // Process Webflow data
  webflowData.forEach((webflowItem) => {
    const itemId = webflowItem.id;
    const itemFields = webflowItem.fieldData || {};
    const aptName = itemFields.name || "";
    const rentCafeApt = rentCafeMap[aptName];

    const fieldsToUpdate = {};
    const changes = [];

    if (rentCafeApt) {
      const newEffectiveRent = rentCafeApt.minimumRent;
      const newOriginalRent = rentCafeApt.maximumRent;
      const newAvailableDate = rentCafeApt.availableDate
        ? new Date(rentCafeApt.availableDate).toISOString()
        : null;
      const isAvailable = ["Vacant Unrented Not Ready", "Vacant Unrented Ready", "Notice Unrented"].includes(
        rentCafeApt.unitStatus
      );

      if (itemFields["effective-rent-amount"] !== newEffectiveRent) {
        changes.push(`"effective-rent-amount": ${itemFields["effective-rent-amount"]} → ${newEffectiveRent}`);
        fieldsToUpdate["effective-rent-amount"] = newEffectiveRent;
      }

      if (itemFields["original-rent-amount"] !== newOriginalRent) {
        changes.push(`"original-rent-amount": ${itemFields["original-rent-amount"]} → ${newOriginalRent}`);
        fieldsToUpdate["original-rent-amount"] = newOriginalRent;
      }

      if (newAvailableDate && itemFields["available-date"] !== newAvailableDate) {
        changes.push(`"available-date": ${itemFields["available-date"]} → ${newAvailableDate}`);
        fieldsToUpdate["available-date"] = newAvailableDate;
      }

      if (itemFields["show-online"] !== isAvailable) {
        changes.push(`"show-online": ${itemFields["show-online"]} → ${isAvailable}`);
        fieldsToUpdate["show-online"] = isAvailable;
      }

      if (Object.keys(fieldsToUpdate).length > 0) {
        fieldsToUpdate.name = aptName;
        fieldsToUpdate.slug = sanitizeSlug(itemFields.slug || aptName);
        fieldsToUpdate._archived = false;
        fieldsToUpdate._draft = false;

        console.log(`[UPDATE] Apt "${aptName}" (Webflow ID: ${itemId}) changes:`);
        console.log(JSON.stringify(fieldsToUpdate, null, 2));
        itemsToUpdate.push({ id: itemId, fieldData: fieldsToUpdate });
      } else {
        console.log(`[NO CHANGE] Apt "${aptName}" (Webflow ID: ${itemId}) is already up to date.`);
      }
    } else if (itemFields["show-online"]) {
      console.log(`[HIDE] Apt "${aptName}" (Webflow ID: ${itemId}) not in RentCafe feed; hiding.`);
      itemsToUpdate.push({
        id: itemId,
        fieldData: {
          "show-online": false,
          name: aptName,
          slug: sanitizeSlug(itemFields.slug || aptName),
          _archived: false,
          _draft: false,
        },
      });
    }
  });

  if (itemsToUpdate.length > 0) {
    console.log(`Preparing to batch update ${itemsToUpdate.length} items...`);
    for (let i = 0; i < itemsToUpdate.length; i += 100) {
      const batch = itemsToUpdate.slice(i, i + 100);
      console.log(`Processing batch ${Math.floor(i / 100) + 1} with ${batch.length} items.`);

      const invalidItems = batch.filter((item) => !item.fieldData || Object.keys(item.fieldData).length === 0);
      if (invalidItems.length > 0) {
        console.error(`Batch contains invalid items. Skipping batch.`);
        console.error(`Invalid items:`, invalidItems);
        continue;
      }

      try {
        await updateWebflowItemsLive(webflowToken, collectionId, batch);
        console.log(`Batch ${Math.floor(i / 100) + 1} update complete.`);
      } catch (error) {
        console.error(`Error updating batch ${Math.floor(i / 100) + 1}:`, error.message);
        console.error(`Failed batch payload:`, JSON.stringify(batch, null, 2));
      }
    }
  } else {
    console.log("No updates required.");
  }
}

module.exports = {
  syncWithWebflow,
};