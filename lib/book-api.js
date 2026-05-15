const MINUMSA_SEARCH_URL = "https://minumsa.com/";
const ALADIN_SEARCH_URL = "https://www.aladin.co.kr/search/wsearchresult.aspx";
const IMAGE_CACHE = new Map();

async function searchBooks(query) {
  const trimmed = String(query || "").trim();
  if (!trimmed) {
    return { books: [], source: "minumsa+aladin" };
  }

  const [minumsaResult, aladinResult] = await Promise.allSettled([searchMinumsaBooks(trimmed), searchAladinBooks(trimmed)]);
  const minumsaBooks = minumsaResult.status === "fulfilled" ? minumsaResult.value : [];
  const aladinBooks = aladinResult.status === "fulfilled" ? aladinResult.value : [];
  return {
    books: mergeBookResults([...minumsaBooks, ...aladinBooks]).slice(0, 12),
    source: "minumsa+aladin",
  };
}

async function searchMinumsaBooks(query) {
  const searchUrl = new URL(MINUMSA_SEARCH_URL);
  searchUrl.searchParams.set("s", query);

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
  return parseMinumsaBooks(html, query);
}

async function searchAladinBooks(query) {
  const searchUrl = new URL(ALADIN_SEARCH_URL);
  searchUrl.searchParams.set("SearchTarget", "Book");
  searchUrl.searchParams.set("SearchWord", query);

  const response = await fetch(searchUrl, {
    headers: {
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.6",
      "user-agent": "BookOrbit/1.0 public preview",
    },
  });

  if (!response.ok) {
    return [];
  }

  const html = await response.text();
  return parseAladinBooks(html, query);
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

  if (parsed.protocol === "http:" && isAladinImageHost(parsed.hostname)) {
    parsed.protocol = "https:";
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

function parseAladinBooks(html, query) {
  const normalizedQuery = normalizeText(query);
  const books = [];
  const blocks = html.matchAll(
    /<div class="ss_book_box"[^>]*itemId="([^"]+)"[\s\S]*?(?=<div class="ss_book_box"[^>]*itemId=|<div id="Search3_UsedOpenMarketItemList_Result"|<\/body>)/gi
  );

  for (const match of blocks) {
    const itemId = match[1];
    const block = match[0];
    const titleMatch = block.match(/<a href="([^"]+)" class="bo3">([\s\S]*?)<\/a>/i);
    const coverSource = decodeHtml(matchFirst(block, /<img[^>]*src="([^"]+)"[^>]*class="front_cover i_cover"/i));
    if (!titleMatch || !coverSource) {
      continue;
    }

    const detailUrl = absoluteUrl(decodeHtml(titleMatch[1]), "https://www.aladin.co.kr");
    const title = cleanHtml(titleMatch[2]);
    const publisher = cleanHtml(matchFirst(block, /PublisherSearch=[^"]+"[^>]*>([\s\S]*?)<\/A>/i)) || "국내 출판";
    const authors = parseAladinAuthors(block);
    const year = matchFirst(block, /<\/A>\s*\|\s*(\d{4})년/i);
    const isMinumsa = /민음사|minumsa/i.test(publisher);

    if (!title || !detailUrl) {
      continue;
    }

    const coverUrl = absoluteUrl(coverSource, "https://www.aladin.co.kr");

    books.push({
      id: `aladin-${itemId}`,
      title,
      authors,
      publisher,
      year,
      status: year ? `${year}` : "",
      source: "알라딘",
      isMinumsa,
      coverUrl: proxyImageUrl(coverUrl),
      largeCoverUrl: proxyImageUrl(toLargeCoverUrl(coverUrl)),
      detailUrl,
      score: scoreAladinBook(title, authors, publisher, normalizedQuery, isMinumsa, block),
    });
  }

  return books.sort((a, b) => b.score - a.score || a.title.length - b.title.length).slice(0, 16);
}

function parseAladinAuthors(block) {
  const metadataItem = (block.match(/<li>[\s\S]*?<\/li>/gi) || []).find((item) => /PublisherSearch=/i.test(item));
  if (!metadataItem) {
    return [];
  }

  const metadata = metadataItem.replace(/^<li>/i, "").replace(/<\/li>$/i, "");
  const publisherIndex = metadata.search(/<a\b[^>]*PublisherSearch=/i);
  const authorHtml = publisherIndex >= 0 ? metadata.slice(0, publisherIndex) : metadata.split("|")[0];
  const authorText = cleanHtml(authorHtml)
    .replace(/\s*\|\s*$/g, "")
    .replace(/\s*\((지은이|옮긴이|글|그림|엮은이|감수)\)\s*/g, "")
    .replace(/\s+외\s*$/g, "")
    .trim();
  if (!authorText) {
    return [];
  }

  return authorText
    .split(/\s*,\s*|\s+\/\s+/)
    .map((author) => author.trim())
    .filter(Boolean)
    .slice(0, 3);
}

function scoreAladinBook(title, authors, publisher, normalizedQuery, isMinumsa, block) {
  const rawTitle = normalizeText(title);
  const normalizedTitle = normalizeTitle(title);
  let score = 0;

  if (rawTitle === normalizedQuery) {
    score += 118;
  } else if (normalizedTitle === normalizedQuery) {
    score += 86;
  } else if (normalizedTitle.includes(normalizedQuery)) {
    score += 72;
  } else if (normalizeText(`${title} ${authors.join(" ")} ${publisher}`).includes(normalizedQuery)) {
    score += 38;
  }

  if (/^\[세트\]/.test(title)) {
    score -= 28;
  }
  if (/큰글자도서|북마크|볼펜|키링|굿즈/.test(title)) {
    score -= 18;
  }
  if (publisher && publisher !== "국내 출판") {
    score += 8;
  }
  if (authors.length) {
    score += 4;
  }
  if (isMinumsa) {
    score += 12;
  }

  const salesPoint = Number(String(matchFirst(block, /sales_point">\s*([\d,]+)/i)).replace(/,/g, ""));
  if (Number.isFinite(salesPoint) && salesPoint > 0) {
    score += Math.min(18, Math.log10(salesPoint) * 3);
  }

  return score;
}

function mergeBookResults(books) {
  const byKey = new Map();
  for (const book of books) {
    const titleKey = normalizeText(book.title).replace(/easypage[_\s-]*/gi, "").trim();
    const authorKey = normalizeText(book.authors?.[0] || "");
    const publisherKey = normalizeText(book.publisher || "");
    const key = [titleKey, authorKey, publisherKey].join("|");
    const existing = byKey.get(key);
    if (!existing || book.score > existing.score || (book.isMinumsa && !existing.isMinumsa)) {
      byKey.set(key, book);
    }
  }

  return [...byKey.values()].sort((a, b) => b.score - a.score || Number(b.isMinumsa) - Number(a.isMinumsa));
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
  return (
    hostname === "minumsa.com" ||
    hostname.endsWith(".minumsa.com") ||
    isAladinImageHost(hostname)
  );
}

function isAladinImageHost(hostname) {
  return hostname === "image.aladin.co.kr";
}

function absoluteUrl(value, base = "https://www.aladin.co.kr") {
  const source = String(value || "").trim();
  if (!source) {
    return "";
  }
  if (source.startsWith("//")) {
    return `https:${source}`;
  }

  try {
    const url = new URL(source, base);
    if (url.protocol === "http:" && isAladinImageHost(url.hostname)) {
      url.protocol = "https:";
    }
    return url.toString();
  } catch {
    return "";
  }
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
