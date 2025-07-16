// rentcafeAuth.js
require("dotenv").config();
const axios = require("axios");

async function getRentCafeBearerToken() {
  try {
    const tokenEndpoint = "https://rentcafeapiportal.yardione.com/connect/token";
    
    // Prepare the form data
    // (We use URLSearchParams or a plain object depending on how RentCafe expects the data)
    const payload = new URLSearchParams();
    payload.append("client_id", "rentcafeapiportal_apiaccess");
    payload.append("grant_type", "password");
    payload.append("username", process.env.RENTCAFE_API_USERNAME);
    payload.append("password", process.env.RENTCAFE_API_PASSWORD);

    // Make the POST request
    const response = await axios.post(tokenEndpoint, payload.toString(), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      }
    });

    const data = response.data;
    console.log("Bearer Token:", data.access_token);
    console.log("Expires in (seconds):", data.expires_in);
    
    // Optionally return it if you want to store it or use it right away
    return data;
    
  } catch (error) {
    console.error("Error getting RentCafe bearer token:", error.response?.data || error.message);
  }
}

// If run directly from the command line: node rentcafeAuth.js
if (require.main === module) {
  (async () => {
    await getRentCafeBearerToken();
  })();
}

// Export the function so we can require it elsewhere
module.exports = { getRentCafeBearerToken };