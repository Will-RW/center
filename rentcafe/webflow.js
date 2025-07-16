const axios = require("axios");

/**
 * Retrieve all items from a specific Webflow collection (v2 endpoint) with pagination.
 * @param {string} webflowToken - Your Webflow API token
 * @param {string} collectionId - The Collection ID in Webflow
 * @returns {Array}             - An array of all items from that collection
 */
async function getAllItemsFromWebflow(webflowToken, collectionId) {
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items`;
  const items = [];
  let offset = 0;
  const limit = 100;

  try {
    while (true) {
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${webflowToken}`,
          "accept-version": "2.0.0",
          "Content-Type": "application/json",
        },
        params: {
          offset, // Pagination offset
          limit,  // Fetch up to 100 items per request
        },
      });

      const batch = response.data.items || [];
      items.push(...batch);

      // If less than 100 items are returned, we've reached the end
      if (batch.length < limit) {
        break;
      }

      // Increment the offset for the next batch
      offset += limit;
    }

    console.log(`Fetched ${items.length} items from Webflow.`);
    return items;
  } catch (error) {
    console.error("Error fetching Webflow items:", error.response?.data || error.message);
    throw error;
  }
}

/**
 * Update multiple items in a Webflow collection (live) with batching.
 * @param {string} webflowToken - Webflow API token
 * @param {string} collectionId - Collection ID in Webflow
 * @param {Array} itemsToUpdate - Array of items to update (each item must include `id` and `fieldData`)
 */
async function updateWebflowItemsLive(webflowToken, collectionId, itemsToUpdate) {
  const url = `https://api.webflow.com/v2/collections/${collectionId}/items/live`;
  const batchSize = 100; // Webflow allows a max of 100 items per batch

  const processBatch = async (batch, batchNumber) => {
    const payload = {
      items: batch.map(item => ({
        id: item.id,
        fieldData: item.fieldData,
      })),
    };

    console.log(`Processing batch ${batchNumber + 1} with ${batch.length} items...`);
    console.log("Batch payload:", JSON.stringify(payload, null, 2));

    try {
      const response = await axios.patch(url, payload, {
        headers: {
          Authorization: `Bearer ${webflowToken}`,
          "accept-version": "2.0.0",
          "Content-Type": "application/json",
        },
      });

      console.log(
        `Batch ${batchNumber + 1} update successful: ${
          response.data.items.length
        } items updated.`
      );

      // Log individual items updated
      response.data.items.forEach(item => {
        console.log(`[UPDATED] Item ID: ${item.id}`);
      });

      return response.data;
    } catch (error) {
      console.error(
        `Error updating batch ${batchNumber + 1}. Status: ${
          error.response?.status
        }, Response: ${JSON.stringify(error.response?.data || error.message)}`
      );
      throw error;
    }
  };

  // Paginate items to avoid exceeding Webflow's batch size limit
  const totalBatches = Math.ceil(itemsToUpdate.length / batchSize);
  console.log(`Preparing to update ${itemsToUpdate.length} items in ${totalBatches} batches.`);

  for (let i = 0; i < totalBatches; i++) {
    const batch = itemsToUpdate.slice(i * batchSize, (i + 1) * batchSize);
    await processBatch(batch, i);
  }

  console.log("All batches processed successfully!");
}

module.exports = {
  getAllItemsFromWebflow,
  updateWebflowItemsLive,
};