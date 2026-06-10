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
  // FB ships listing data in <script type="application/json"> blobs. A blob can
  // contain MANY listings (search results, "more like this"), so regex-grabbing
  // the first matching field is wrong. Parse properly and walk the tree to the
  // single object whose id matches the item in the URL; read only its fields.

  function scrapeEmbeddedJson(itemId) {
    if (!itemId) return null;
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent;
      if (!text || !text.includes(itemId) || !text.includes("marketplace_listing_title")) {
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const node = findListingNode(data, itemId);
      if (!node) continue;

      return {
        title: node.marketplace_listing_title ?? node.custom_title ?? null,
        price: extractPrice(node.listing_price),
        description: node.redacted_description?.text ?? null,
        location:
          node.location_text?.text ??
          cityState(node.location?.reverse_geocode ?? node.location_vanity_or_id) ??
          null,
      };
    }
    return null;
  }

  // Depth-first search for the listing object: it carries the matching id AND
  // listing fields (other objects share the id, e.g. tracking refs).
  function findListingNode(root, itemId) {
    const stack = [root];
    let steps = 0;
    while (stack.length > 0 && steps < 200000) {
      const node = stack.pop();
      steps += 1;
      if (!node || typeof node !== "object") continue;
      if (
        node.id === itemId &&
        (node.marketplace_listing_title != null || node.listing_price != null)
      ) {
        return node;
      }
      for (const value of Object.values(node)) {
        if (value && typeof value === "object") stack.push(value);
      }
    }
    return null;
  }

  function extractPrice(listingPrice) {
    if (!listingPrice || typeof listingPrice !== "object") return null;
    if (listingPrice.formatted_amount) return listingPrice.formatted_amount;
    if (listingPrice.amount != null) return `$${listingPrice.amount}`;
    return null;
  }

  function cityState(geo) {
    if (!geo || typeof geo !== "object") return null;
    if (geo.city && geo.state) return `${geo.city}, ${geo.state}`;
    if (geo.city_page?.display_name) return geo.city_page.display_name;
    return null;
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
