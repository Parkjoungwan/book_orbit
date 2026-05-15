const http = require("node:http");
const { extname, join, normalize } = require("node:path");
const { readFile } = require("node:fs/promises");
const { fetchAllowedImage, searchBooks } = require("../lib/book-api");

const PORT = Number(process.env.PORT || 4173);
const HOST = "127.0.0.1";
const ROOT = join(__dirname, "..", "public");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
};

http
  .createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host}`);

      if (url.pathname === "/api/search") {
        await handleSearch(url, res);
        return;
      }

      if (url.pathname === "/api/image") {
        await handleImage(url, res);
        return;
      }

      await serveStatic(url, res);
    } catch (error) {
      sendJson(res, 500, { error: "internal_error", message: error.message });
    }
  })
  .listen(PORT, HOST, () => {
    console.log(`Book Orbit running at http://${HOST}:${PORT}/`);
  });

async function handleSearch(url, res) {
  const query = (url.searchParams.get("q") || "").trim();
  if (!query) {
    sendJson(res, 200, { books: [] });
    return;
  }

  sendJson(res, 200, await searchBooks(query));
}

async function handleImage(url, res) {
  try {
    const image = await fetchAllowedImage(url.searchParams.get("src") || "");
    res.writeHead(200, {
      "Access-Control-Allow-Origin": "*",
      "Cache-Control": "public, max-age=86400",
      "Content-Type": image.contentType,
    });
    res.end(image.bytes);
  } catch (error) {
    res.writeHead(error.statusCode || 500);
    res.end(error.message || "Image fetch failed");
  }
}

async function serveStatic(url, res) {
  const pathname = url.pathname === "/" ? "/index.html" : decodeURIComponent(url.pathname);
  const filePath = normalize(join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const content = await readFile(filePath);
    const contentType = MIME_TYPES[extname(filePath).toLowerCase()] || "application/octet-stream";
    res.writeHead(200, {
      "Cache-Control": "no-store",
      "Content-Type": contentType,
    });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
  });
  res.end(JSON.stringify(payload));
}
