// DealScan scraper — runs inside facebook.com/marketplace pages.
//
// Strategy, in order of reliability:
//   1. Facebook's embedded JSON. Listing pages ship the listing data
//      (title, price, description, location) inside <script> tags. We find
//      the blob that contains the current item ID and pull exact values.
//   2. DOM heuristics that can't hit the wrong layer. Listings opened from
//      search render as an overlay ON TOP of the search page, so naive
//      "first h1 / first price" reads the page underneath. Fallbacks:
//      document.title for the name (FB keeps it updated), and largest
//      font-size for the price (the real price is huge, rail prices tiny).
//
// Classic script (no ES modules in content scripts). Exposes one message:
//   { type: "SCRAPE_LISTING" } → { ok, data: rawListing }

(() => {
  // Guard against double injection (the side panel re-injects on demand when
  // a tab predates the extension load).
  if (window.__dealscanScraper) return;
  window.__dealscanScraper = true;

  const PRICE_START_RE = /^(?:\$|£|€|CA\$|A\$)\s?[\d,]+(?:\.\d{2})?/;

  function scrapeListing() {
    const itemId = currentItemId();
    const fromJson = scrapeEmbeddedJson(itemId) ?? {};

    return {
      url: location.href,
      scrapedAt: Date.now(),
      title: fromJson.title ?? getTitleFromDom(),
      price: fromJson.price ?? getPriceFromDom(),
      description: fromJson.description ?? getDescriptionFromDom(),
      condition: getLabeledValue("Condition"),
      location: fromJson.location ?? getLocationFromDom(),
      seller: getSeller(),
      images: getImages(),
    };
  }

  function currentItemId() {
    const m = location.pathname.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  // --- Strategy 1: embedded JSON ----------------------------------------------

  function scrapeEmbeddedJson(itemId) {
    if (!itemId) return null;
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent;
      // Must be marketplace listing data AND belong to THIS item — stale blobs
      // from previously viewed listings stay in the DOM after SPA navigation.
      if (!text || !text.includes("marketplace_listing_title") || !text.includes(itemId)) {
        continue;
      }
      const title = jsonStringField(text, "marketplace_listing_title");
      if (!title) continue;

      return {
        title,
        price: jsonStringField(text, "formatted_amount"),
        description: jsonNestedText(text, "redacted_description"),
        location: jsonNestedText(text, "location_text") ?? jsonCityState(text),
      };
    }
    return null;
  }

  // '"key":"value"' → unescaped value.
  function jsonStringField(text, key) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? safeJsonString(m[1]) : null;
  }

  // '"key":{"text":"value"...' → unescaped value.
  function jsonNestedText(text, key) {
    const m = text.match(new RegExp(`"${key}"\\s*:\\s*\\{"text"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
    return m ? safeJsonString(m[1]) : null;
  }

  function jsonCityState(text) {
    const m = text.match(/"city"\s*:\s*"((?:[^"\\]|\\.)*)"\s*,\s*"state"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    return m ? `${safeJsonString(m[1])}, ${safeJsonString(m[2])}` : null;
  }

  function safeJsonString(escaped) {
    try {
      return JSON.parse(`"${escaped}"`);
    } catch {
      return escaped;
    }
  }

  // --- Strategy 2: DOM fallbacks ------------------------------------------------

  function getTitleFromDom() {
    // document.title tracks the open listing even when it's an overlay:
    // "(2) Marketplace - ADULT MEN'S 11 PIECE GOLF SET | Facebook"
    const fromTitle = document.title
      .replace(/^\(\d+\)\s*/, "")
      .replace(/^Marketplace\s*[-–—]\s*/i, "")
      .replace(/\s*[|]\s*Facebook\s*$/i, "")
      .trim();
    if (fromTitle && !/^(marketplace|facebook|search results)$/i.test(fromTitle)) {
      return fromTitle;
    }
    // Last resort: an h1 that isn't a generic page heading.
    for (const h1 of document.querySelectorAll("h1")) {
      const text = h1.textContent?.trim();
      if (text && !/^(search results|marketplace|facebook)$/i.test(text)) return text;
    }
    return null;
  }

  function getPriceFromDom() {
    // The listing's own price renders much larger than prices in the
    // "more like this" rail or the search page beneath an overlay. Among
    // price-shaped leaf nodes, take the one with the biggest font.
    let best = null;
    let bestSize = 0;
    for (const el of document.querySelectorAll("span")) {
      if (el.children.length > 0) continue;
      const text = el.textContent?.trim() ?? "";
      if (text.length > 30 || !PRICE_START_RE.test(text)) continue;
      const size = parseFloat(getComputedStyle(el).fontSize) || 0;
      if (size > bestSize) {
        bestSize = size;
        best = text.match(PRICE_START_RE)[0];
      }
    }
    return best;
  }

  function getDescriptionFromDom() {
    // Longest leaf text block — crude, but only used when the JSON blob is
    // missing. Skips short strings and obvious price/status fragments.
    let best = null;
    for (const el of document.querySelectorAll("div[role] span, div[role] div")) {
      if (el.children.length > 0) continue;
      const text = el.textContent?.trim() ?? "";
      if (text.length < 60) continue;
      if (!best || text.length > best.length) best = text;
    }
    return best;
  }

  function getLabeledValue(label) {
    // Detail rows render as "Label\nValue" pairs, e.g. "Condition Used – Good".
    for (const el of document.querySelectorAll("span, div")) {
      const text = el.textContent?.trim() ?? "";
      if (
        text.startsWith(label) &&
        text.length < 80 &&
        text.length > label.length &&
        el.children.length <= 2
      ) {
        return text.slice(label.length).replace(/^[\s:·–-]+/, "").trim() || null;
      }
    }
    return null;
  }

  function getLocationFromDom() {
    const m = document.body.textContent.match(
      /Listed[^·\n]*?\bin\s+([A-Z][\w\s.,'-]{2,40})/
    );
    return m ? m[1].trim() : null;
  }

  function getSeller() {
    const sellerLink = document.querySelector(
      'a[href*="/marketplace/profile/"], a[href*="facebook.com/profile"]'
    );
    const text = sellerLink?.textContent?.trim();
    return text && text.length < 60 ? text : null;
  }

  function getImages() {
    const urls = new Set();
    for (const img of document.querySelectorAll("img")) {
      const src = img.src || "";
      // Listing photos come from FB's scontent CDN; skip avatars/emoji (tiny).
      if (src.includes("scontent") && img.naturalWidth >= 200) {
        urls.add(src);
      }
    }
    return [...urls].slice(0, 10);
  }

  // --- Message interface --------------------------------------------------------

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "SCRAPE_LISTING") return false;
    try {
      sendResponse({ ok: true, data: scrapeListing() });
    } catch (err) {
      sendResponse({ ok: false, error: String(err) });
    }
    return false; // synchronous response
  });
})();
