const { fetchAllowedImage } = require("../lib/book-api");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || "book-orbit.local"}`);
    const image = await fetchAllowedImage(url.searchParams.get("src") || "");
    res.statusCode = 200;
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "public, max-age=86400");
    res.setHeader("Content-Type", image.contentType);
    res.end(image.bytes);
  } catch (error) {
    res.statusCode = error.statusCode || 500;
    res.end(error.message || "Image fetch failed");
  }
};
