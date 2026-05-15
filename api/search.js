const { searchBooks } = require("../lib/book-api");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    res.statusCode = 405;
    res.end("Method not allowed");
    return;
  }

  try {
    const url = new URL(req.url, `https://${req.headers.host || "book-orbit.local"}`);
    const payload = await searchBooks(url.searchParams.get("q") || "");
    sendJson(res, 200, payload);
  } catch (error) {
    sendJson(res, error.statusCode || 500, {
      error: error.message || "internal_error",
    });
  }
};

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}
