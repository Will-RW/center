// prerender-mw.js — mountable router (no server.listen here)
// Requires: express (already installed / or `npm i express`)

const express = require("express");

const ORIGIN = process.env.ORIGIN_URL;                // e.g. https://www.esox.house
const RENDERTRON = process.env.RENDERTRON_URL;        // e.g. https://rendertron-xxxx.onrender.com
const BOT_RE = new RegExp(
  process.env.BOT_REGEX || "bot|crawler|spider|googlebot|bingbot|yandex|baiduspider|duckduckbot|facebookexternalhit|slackbot",
  "i"
);

function buildRendertronURL(fullUrl) {
  const encoded = encodeURIComponent(fullUrl);
  const timeout = 15000; // allow Wized to settle; tweak if needed
  return `${RENDERTRON}/render/${encoded}?timeout=${timeout}`;
}

const router = express.Router();

// Health (for sanity checks)
router.get("/healthz", (req, res) => res.status(200).send("ok"));

// Catch-all under /__prerender/*
// Example call you'll test:
//   https://<CENTER>.onrender.com/__prerender/center?type=jr1-beds
router.use(async (req, res) => {
  try {
    const ua = req.headers["user-agent"] || "";
    const accept = req.headers["accept"] || "";
    const isHTML = /text\/html/i.test(accept);
    const isBot = BOT_RE.test(ua);

    // Remove the mount prefix "/__prerender" so we can forward the real path+query to origin
    const forwardedPath = req.originalUrl.replace(/^\/__prerender/, "") || "/";
    const upstreamUrl = new URL(forwardedPath, ORIGIN).toString();

    if (isBot && isHTML) {
      // BOT path → Rendertron
      const snapUrl = buildRendertronURL(upstreamUrl);
      const r = await fetch(snapUrl, {
        headers: { "User-Agent": ua, "X-Forwarded-Host": req.headers.host || "" }
      });
      res.status(r.status);
      r.headers.forEach((v, k) => {
        if (k.toLowerCase() !== "content-encoding") res.setHeader(k, v);
      });
      res.setHeader("Cache-Control", "public, max-age=300");
      const html = await r.text();
      return res.send(html);
    }

    // HUMAN (or non-HTML) → pass through to Webflow
    const upstream = await fetch(upstreamUrl, {
      method: req.method,
      headers: { ...req.headers, host: new URL(ORIGIN).host }
    });
    res.status(upstream.status);
    upstream.headers.forEach((v, k) => res.setHeader(k, v));
    const body = await upstream.arrayBuffer();
    return res.send(Buffer.from(body));
  } catch (err) {
    console.error("[prerender-mw] error:", err);
    res.status(502).send("proxy error");
  }
});

module.exports = router;
