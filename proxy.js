// proxy.js  — public proxy in front of Webflow + Rendertron
// Requires: express (npm i express)

const express = require("express");

// Env vars you already set in Render -> Center -> Environment
const ORIGIN = process.env.ORIGIN_URL;                    // e.g. https://www.esox.house
const RENDERTRON = process.env.RENDERTRON_URL;            // e.g. https://rendertron-n08h.onrender.com
const BOT_RE = new RegExp(process.env.BOT_REGEX || "bot|crawler|spider|googlebot|bingbot", "i");

// small helper: encode full URL for Rendertron
function rendertronURL(fullUrl) {
  // Rendertron expects: /render/<encoded full URL>?timeout=...
  const encoded = encodeURIComponent(fullUrl);
  const timeout = 15000;         // let Wized settle; adjust if needed
  return `${RENDERTRON}/render/${encoded}?timeout=${timeout}`;
}

const app = express();

// healthcheck for Render
app.get("/healthz", (req, res) => res.status(200).send("ok"));

// main proxy
app.use(async (req, res) => {
  try {
    const ua = req.headers["user-agent"] || "";
    const accept = req.headers["accept"] || "";
    const isHTML = accept.includes("text/html");
    const isBot = BOT_RE.test(ua);

    // full origin URL (includes path + query)
    const fullOriginUrl = ORIGIN + req.originalUrl;

    if (isHTML && isBot) {
      // --- BOT path -> Rendertron snapshot ---
      const snapUrl = rendertronURL(fullOriginUrl);
      const r = await fetch(snapUrl, {
        headers: {
          "User-Agent": ua,
          "X-Forwarded-Host": req.headers.host || ""
        }
      });

      // pass through status + headers (minus content-encoding)
      res.status(r.status);
      r.headers.forEach((v, k) => {
        if (k.toLowerCase() !== "content-encoding") res.setHeader(k, v);
      });
      res.setHeader("Cache-Control", "public, max-age=300");

      const html = await r.text();
      return res.send(html);
    }

    // --- HUMAN path -> proxy to Webflow origin ---
    const upstream = await fetch(fullOriginUrl, {
      method: "GET",                       // your Webflow site is GET-only
      headers: { ...req.headers, host: new URL(ORIGIN).host }
    });

    res.status(upstream.status);
    upstream.headers.forEach((v, k) => res.setHeader(k, v));
    const body = await upstream.arrayBuffer();
    return res.send(Buffer.from(body));
  } catch (err) {
    console.error(err);
    res.status(502).send("Proxy error");
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log("Proxy running on", PORT));
