const MINUMSA_SEARCH_URL = "https://minumsa.com/";
const IMAGE_CACHE = new Map();

async function searchBooks(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return { books: [], source: "minumsa" };
  }

  const searchUrl = new URL(MINUMSA_SEARCH_URL);
  searchUrl.searchParams.set("s", trimmed);

  const response = await fetch(searchUrl, {
    headers: {
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.6",
      "user-agent": "BookOrbit/1.0 public preview",
    },
  });

  if (!response.ok) {
    const error = new Error("source_failed");
    error.statusCode = 502;
    throw error;
  }

  const html = await response.text();
  return { books: parseMinumsaBooks(html, trimmed), source: "minumsa" };
}

async function fetchAllowedImage(source) {
  let parsed;
  try {
    parsed = new URL(source || "");
  } catch {
    const error = new Error("invalid_image_url");
    error.statusCode = 400;
    throw error;
  }

  if (parsed.protocol !== "https:" || !isAllowedImageHost(parsed.hostname)) {
    const error = new Error("image_host_not_allowed");
    error.statusCode = 403;
    throw error;
  }

  const cacheKey = parsed.toString();
  let cached = IMAGE_CACHE.get(cacheKey);
  if (cached) {
    return cached;
  }

  const response = await fetch(cacheKey, {
    headers: {
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.6",
      "user-agent": "BookOrbit/1.0 public preview",
    },
  });

  if (!response.ok) {
    const error = new Error("image_fetch_failed");
    error.statusCode = response.status;
    throw error;
  }

  cached = {
    bytes: Buffer.from(await response.arrayBuffer()),
    contentType: response.headers.get("content-type") || "image/jpeg",
  };
  if (IMAGE_CACHE.size > 80) {
    IMAGE_CACHE.delete(IMAGE_CACHE.keys().next().value);
  }
  IMAGE_CACHE.set(cacheKey, cached);
  return cached;
}

function parseMinumsaBooks(html, query) {
  const blocks = html.split(/<div id="book-embed-/).slice(1);
  const normalizedQuery = normalizeText(query);
  const seen = new Set();
  const books = [];

  for (const block of blocks) {
    const title = cleanHtml(matchFirst(block, /<div class="book-title">[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/i));
    const detailUrl = decodeHtml(matchFirst(block, /<div class="book-title">[\s\S]*?<a[^>]*href="([^"]+)"/i));
    const coverSource = decodeHtml(matchFirst(block, /<div class="book-thumbnail">[\s\S]*?<img[^>]*src="([^"]+)"/i));

    if (!title || !detailUrl || !coverSource) {
      continue;
    }

    const authors = parseAuthors(block);
    const publisher = publisherFromUrl(detailUrl);
    const isSoldOut = /book-soldout/.test(block);
    const largeCoverSource = toLargeCoverUrl(coverSource);
    const dedupeKey = normalizeText(`${title} ${authors.join(" ")} ${publisher}`);

    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);

    books.push({
      id: `minumsa-${hash(`${title}-${detailUrl}`)}`,
      title,
      authors,
      publisher,
      year: "",
      status: isSoldOut ? "절판" : "",
      source: "민음사 출판그룹",
      isMinumsa: detailUrl.includes("minumsa.minumsa.com"),
      coverUrl: proxyImageUrl(coverSource),
      largeCoverUrl: proxyImageUrl(largeCoverSource),
      detailUrl,
      score: scoreBook(title, normalizedQuery, detailUrl, isSoldOut),
    });
  }

  const titleMatches = books.filter((book) => normalizeTitle(book.title).includes(normalizedQuery));
  const pool = titleMatches.length ? titleMatches : books;
  return pool.sort((a, b) => b.score - a.score || a.title.length - b.title.length).slice(0, 12);
}

function parseAuthors(block) {
  const authorHtml = matchFirst(block, /<span class="book-author">([\s\S]*?)<\/span>\s*<\/div>/i);
  if (!authorHtml) {
    return [];
  }

  return cleanHtml(authorHtml)
    .split("|")
    .map((part) => part.replace(/^\s*(글|옮김|그림)\s+/, "").trim())
    .filter(Boolean)
    .slice(0, 3);
}

function scoreBook(title, normalizedQuery, detailUrl, isSoldOut) {
  const normalizedTitle = normalizeTitle(title);
  let score = 0;

  if (normalizedTitle === normalizedQuery) {
    score += 120;
  } else if (normalizedTitle.includes(normalizedQuery)) {
    score += 70;
  }

  if (detailUrl.includes("minumsa.minumsa.com")) {
    score += 35;
  }
  if (!isSoldOut) {
    score += 8;
  }
  if (/easypage|교보문고/i.test(title)) {
    score -= 16;
  }

  return score;
}

function publisherFromUrl(value) {
  const host = new URL(value).hostname;
  const map = {
    "minumsa.minumsa.com": "민음사",
    "goldenbough.minumsa.com": "황금가지",
    "sciencebooks.minumsa.com": "사이언스북스",
    "semicolon.minumsa.com": "세미콜론",
    "minumin.minumsa.com": "민음인",
    "panmidong.minumsa.com": "판미동",
    "banbi.minumsa.com": "반비",
    "pulp.minumsa.com": "펄프",
    "bir.minumsa.com": "비룡소",
  };
  return map[host] || "민음사 출판그룹";
}

function toLargeCoverUrl(value) {
  return value.replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/i, "$1");
}

function proxyImageUrl(value) {
  return `/api/image?src=${encodeURIComponent(value)}`;
}

function isAllowedImageHost(hostname) {
  return hostname === "minumsa.com" || hostname.endsWith(".minumsa.com");
}

function matchFirst(value, pattern) {
  const match = value.match(pattern);
  return match ? match[1] : "";
}

function cleanHtml(value) {
  return decodeHtml(value)
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#039;/g, "'");
}

function normalizeTitle(value) {
  return normalizeText(value)
    .replace(/\[[^\]]+\]/g, "")
    .replace(/\([^)]*\)/g, "")
    .replace(/easypage[_\s-]*/gi, "")
    .trim();
}

function normalizeText(value) {
  return String(value || "")
    .toLocaleLowerCase("ko-KR")
    .replace(/\s+/g, " ")
    .trim();
}

function hash(value) {
  let result = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    result ^= value.charCodeAt(i);
    result = Math.imul(result, 16777619);
  }
  return (result >>> 0).toString(36);
}

module.exports = {
  fetchAllowedImage,
  searchBooks,
};
