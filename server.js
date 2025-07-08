/**** server.js ****/
const fastify = require("fastify")();
const fs = require("fs");
const path = require("path");

// Load domain map from JSON
const raw = fs.readFileSync(path.join(__dirname, "domain.json"), "utf8");
const domainMap = JSON.parse(raw);

// Load .env variables
require("dotenv").config(); 

fastify.get("/wized.js", async (request, reply) => {
  try {
    // 1) Read the raw Wized export (with %%ID%% and %%TOKEN%% placeholders)
    const exportPath = path.join(__dirname, "wized.js");
    let contents = fs.readFileSync(exportPath, "utf8");

    // 2) Get the "site" query param, e.g. ?site=southsider
    const siteParam = request.query.site;

    // 3) Lookup the domain entry by siteParam, fallback to "default"
    const domainEntry = domainMap[siteParam] || domainMap.default;
    const domainID = domainEntry.id || "none";

    // 4) Pull the token from .env
    // If .env is missing it, fallback to "UNSET" or something
    const envToken = process.env.CENTROID_TOKEN || "UNSET";

    // 5) Replace placeholders
    contents = contents
      .replace("%%ID%%", domainID)
      .replace("%%TOKEN%%", envToken);

    // 6) Send as JS
    reply.type("application/javascript").send(contents);
  } catch (err) {
    console.error("Failed to read or parse wized.js:", err);
    reply.code(500).send("Server Error");
  }
});

// Start server
const port = process.env.PORT || 3000;
fastify.listen({ port, host: "0.0.0.0" }, (err, address) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  console.log(`Fastify server running at ${address}`);
});