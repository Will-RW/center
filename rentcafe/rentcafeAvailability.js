// rentcafeAvailability.js
require("dotenv").config();
const axios = require("axios");
const { getRentCafeBearerToken } = require("./rentcafeAuth");

/**
 * Fetch apartment availability from RentCafe's "basic" endpoint
 *
 * @param {string} vendor          - e.g. "yardi@wearewherever.com" (from cURL)
 * @param {string} apiToken        - e.g. process.env.RENTCAFE_VENDOR_TOKEN_SATURDAY
 * @param {string} companyCode     - e.g. process.env.RENTCAFE_COMPANY_CODE_SATURDAY
 * @param {string} propertyCode    - e.g. process.env.RENTCAFE_PROPERTY_CODE_REVELRY
 */
async function getApartmentAvailability(vendor, apiToken, companyCode, propertyCode) {
  try {
    // 1. Get a fresh Bearer token
    const tokenResponse = await getRentCafeBearerToken();
    const bearerToken = tokenResponse?.access_token;

    // 2. Prepare the request URL & headers
    const url = "https://basic.rentcafeapi.com/apartmentavailability/getapartmentavailability";
    const headers = {
      accept: "text/plain",        // as per your cURL
      vendor: vendor,              // e.g. "yardi@wearewherever.com"
      Authorization: `Bearer ${bearerToken}`,
      "Content-Type": "application/json",
    };

    // 3. Build the request body
    const body = {
      apiToken: apiToken,          // e.g. "c0cd6176-a144-4cff-978a-20fcc9f1f7c3"
      companyCode: companyCode,    // e.g. "c00000089567"
      propertyCode: propertyCode,  // e.g. "p1672499"
      showAllUnit: true,           // same as your cURL
    };

    // 4. Make the POST request
    const response = await axios.post(url, body, { headers });

    // 5. Return or log the availability data
    const data = response.data;
    console.log("Availability data:", data);
    return data;
  } catch (error) {
    console.error(
      "Error fetching apartment availability:",
      error.response?.data || error.message
    );
    return null;
  }
}

// If run directly (node rentcafeAvailability.js), do a quick test
if (require.main === module) {
  (async () => {
    await getApartmentAvailability(
      "yardi@wearewherever.com",                    // or from .env if you like
      process.env.RENTCAFE_VENDOR_TOKEN_SATURDAY,   // "c0cd6176-a144-4cff-978a-20fcc9f1f7c3"
      process.env.RENTCAFE_COMPANY_CODE_SATURDAY,   // "c00000089567"
      process.env.RENTCAFE_PROPERTY_CODE_REVELRY    // or process.env.RENTCAFE_PROPERTY_CODE_REVELRY
    );
  })();
}

module.exports = { getApartmentAvailability };