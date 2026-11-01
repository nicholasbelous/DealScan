// DealScan scraper — runs inside facebook.com/marketplace pages.
//
// RELIABILITY MODEL
// Facebook is a single-page app that bundles many listings into one page
// (search results, "more like this", the open listing) and loads listing data
// dynamically. A naive "first price / biggest font" read can lock onto the
// WRONG item; relying only on embedded JSON refuses too often (the JSON isn't
// present after in-app navigation). So we use THREE sources:
//
//   1. Embedded JSON  — walked to the object whose `id` === the URL item id.
//                       Usually present after a full page load.
//   2. Listing panel  — the smallest container around a product_id link that
//                       also holds a title and price, and no links to other
//                       listings. Title, price, and ID all come from that one
//                       container. Works after in-app navigation.
//   3. DOM            — title taken from the page title, price read from the
//                       element next to it. NOT tied to an item id, so it only
//                       fills gaps and can never make a read trustworthy alone.
//
// The scraper only reports what it saw. The decision to trust the read is made
// in one place, checkRead() in parser.js.
//
// PRIVACY: product_id links are the seller's profile links. We extract only the
// product_id parameter and never read, keep, or log the rest of the URL.
//
// Classic script (no ES modules in content scripts). Exposes one message:
//   { type: "SCRAPE_LISTING" } → { ok, data: rawListing }

(() => {
  // Guard against double injection (the panel re-injects on demand).
  if (window.__dealscanScraper) return;
  window.__dealscanScraper = true;

  const PRICE_RE = /(?:CA\$|A\$|\$|£|€)\s?\d[\d,]*(?:\.\d{2})?/;

  function scrapeListing() {
    const itemId = currentItemId();

    // Build each source independently (any may be null).
    const jsonNode = itemId ? findListingNode(itemId) : null;
    const json = jsonNode ? sourceFromJson(jsonNode) : null;
    const panel = itemId ? findListingPanel() : null;
    const panelMatches = panel?.itemIds.length === 1 && panel.itemIds[0] === itemId;
    const panelSource = panelMatches ? sourceFromPanel(panel, itemId) : null;
    const dom = fromDom();

    // The first source tied to the URL's item id with BOTH title and price.
    // Title and price are taken from it alone, never mixed across sources.
    const verified = [json, panelSource].find((s) => s && s.title && s.price) ?? null;
    const verifiedBy = verified?.via ?? null;

    // A verified panel fills the other fields itself: the wider page could
    // hold text from other listings in the feed behind it.
    const sources = [json, panelSource, panelSource ? null : dom].filter(Boolean);
    const pick = (field) => {
      for (const s of sources) {
        if (s[field] != null && s[field] !== "") return s[field];
      }
      return null;
    };

    const title = verified?.title ?? pick("title");
    const price = verified?.price ?? pick("price");

    // The open panel names a DIFFERENT item than the URL: Facebook hasn't
    // finished swapping to the clicked listing yet.
    const transitioning = !!panel && panel.itemIds.length > 0 && !panel.itemIds.includes(itemId);

    // Vehicle facts (mileage/year) — extracted reliably and sent as explicit
    // fields so pricing never depends on the messy free-text description.
    const titleEl = panelSource?.titleEl ?? (title ? findElementByText(title) : null);
    const attributes = extractAttributes(title, titleEl);

    const data = {
      url: location.href,
      verifiedItemId: verified?.itemId ?? null,
      verifiedBy,
      transitioning,
      // Cross-checks on a panel read. Evaluated by the gate, never stored or sent.
      titleInDocument: titleInDocument(title),
      feedCardLabel: panelSource ? feedCardLabel(itemId, panel.el) : null,
      title,
      price,
      description: pick("description"),
      condition: pick("condition"),
      location: pick("location"),
      attributes,
      // Photos only from the canonical JSON; see the note in fromDom().
      images: json?.images ?? [],
    };

    // Lightweight diagnostics so failures are reportable from the page console.
    try {
      console.debug("[DealScan] scrape", {
        itemId,
        verifiedBy,
        transitioning,
        title,
        price,
        via: [json, panelSource, dom].filter(Boolean).map((s) => s.via),
      });
    } catch {
      /* console may be unavailable */
    }
    return data;
  }

  function currentItemId() {
    const m = location.pathname.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  // === SOURCE 1: embedded JSON (id-verified) ==================================

  function sourceFromJson(node) {
    return {
      via: "embedded_data",
      itemId: node.id,
      title: node.marketplace_listing_title ?? node.custom_title ?? null,
      price: extractJsonPrice(node.listing_price),
      description: node.redacted_description?.text ?? null,
      condition: conditionText(node),
      location: locationText(node),
      images: collectImageUrls(node),
    };
  }

  function findListingNode(itemId) {
    // Some FB blobs are typed application/json, some aren't — scan any script
    // that mentions this item and a listing field, then parse + walk it.
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent;
      if (!text || text.length < 40) continue;
      if (!text.includes(itemId) || !text.includes("marketplace_listing_title")) continue;
      const json = extractJsonObject(text);
      if (!json) continue;
      const node = walkForListing(json, itemId);
      if (node) return node;
    }
    return null;
  }

  // A <script> may be pure JSON or JS that contains a JSON literal. Try a
  // straight parse first, then fall back to the first balanced {...} blob.
  function extractJsonObject(text) {
    try {
      return JSON.parse(text);
    } catch {
      /* not pure JSON — try to slice out a JSON object below */
    }
    const start = text.indexOf("{");
    if (start === -1) return null;
    try {
      return JSON.parse(text.slice(start));
    } catch {
      return null;
    }
  }

  // Depth-first search for the listing object: matching id AND a listing field.
  function walkForListing(root, itemId) {
    const stack = [root];
    let steps = 0;
    while (stack.length > 0 && steps < 400000) {
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

  function extractJsonPrice(listingPrice) {
    if (!listingPrice || typeof listingPrice !== "object") return null;
    if (listingPrice.formatted_amount) return listingPrice.formatted_amount;
    if (listingPrice.amount != null) return formatAmount(listingPrice.amount, listingPrice.currency);
    return null;
  }

  function conditionText(node) {
    return (
      node.condition?.text ??
      (typeof node.condition === "string" ? node.condition : null) ??
      null
    );
  }

  function locationText(node) {
    return (
      node.location_text?.text ??
      cityState(node.location?.reverse_geocode) ??
      node.location_vanity_or_id ??
      null
    );
  }

  function cityState(geo) {
    if (!geo || typeof geo !== "object") return null;
    if (geo.city && geo.state) return `${geo.city}, ${geo.state}`;
    if (geo.city_page?.display_name) return geo.city_page.display_name;
    return null;
  }

  // ONLY the listing's real photos, from FB's canonical photo fields, in order.
  // We never scavenge arbitrary image URLs (avatars/icons/blur thumbs read as
  // "placeholder images" and poison the evaluation).
  function collectImageUrls(node) {
    const urls = [];
    const seen = new Set();
    const push = (uri) => {
      if (typeof uri === "string" && /^https:\/\//.test(uri) && !seen.has(uri)) {
        seen.add(uri);
        urls.push(uri);
      }
    };
    if (Array.isArray(node.listing_photos)) {
      for (const photo of node.listing_photos) {
        push(photo?.image?.uri ?? photo?.photo_image_url ?? photo?.uri);
      }
    }
    push(node.primary_listing_photo?.photo_image_url);
    push(node.primary_listing_photo?.image?.uri);
    push(node.primary_listing_photo?.listing_image?.uri);
    return urls.slice(0, 6);
  }

  // === SOURCE 2: the listing panel (product_id-verified) ======================

  function findListingPanel() {
    for (const link of document.querySelectorAll('a[href*="product_id="]')) {
      const panel = panelAround(link);
      if (panel) return { ...panel, itemIds: productIdsIn(panel.el) };
    }
    return null;
  }

  // Climb from a product_id link to the smallest container that also holds a
  // title and price. Stop at the first ancestor linking to any listing: that
  // is the feed or a search card, whose IDs belong to other listings.
  function panelAround(link) {
    let node = link.parentElement;
    for (; node && node !== document.body; node = node.parentElement) {
      if (node.querySelector('a[href*="/marketplace/item/"]')) return null;
      const found = panelTitleAndPrice(node);
      if (found) return { el: node, ...found };
    }
    return null;
  }

  function panelTitleAndPrice(scope) {
    for (const el of scope.querySelectorAll('h1, h2, [role="heading"]')) {
      const title = el.textContent.replace(/\s+/g, " ").trim();
      const price = title ? firstPriceAfter(scope, el) : null;
      if (price) return { titleEl: el, title, price };
    }
    // FB sometimes renders the title in a plain span.
    const docTitle = normalizeText(stripDocumentTitle(document.title));
    for (const el of scope.querySelectorAll("span, div")) {
      if (el.childElementCount > 1 || normalizeText(el.textContent) !== docTitle) continue;
      const price = firstPriceAfter(scope, el);
      if (price) return { titleEl: el, title: el.textContent.trim(), price };
    }
    return null;
  }

  // Only the product_id parameter leaves this function.
  function productIdsIn(scope) {
    const ids = new Set();
    for (const a of scope.querySelectorAll('a[href*="product_id="]')) {
      try {
        const id = new URL(a.getAttribute("href"), location.origin).searchParams.get("product_id");
        if (id && /^\d+$/.test(id)) ids.add(id);
      } catch {
        /* malformed href — ignore */
      }
    }
    return [...ids];
  }

  function sourceFromPanel(panel, itemId) {
    return {
      via: "panel_product_id",
      itemId,
      titleEl: panel.titleEl,
      title: panel.title,
      price: panel.price,
      description: longestDetailText(panel.el),
      condition: labeledValueDom("Condition", panel.el),
      location: locationFromDom(panel.el),
    };
  }

  // The search card for this exact item, if one is still on the page behind
  // the panel. Its label reads "<title>, <price>, <location>, listing <id>".
  function feedCardLabel(itemId, panelEl) {
    const cardHref = new RegExp(`/marketplace/item/${itemId}(?:[/?]|$)`);
    for (const a of document.querySelectorAll('a[aria-label][href*="/marketplace/item/"]')) {
      if (!panelEl.contains(a) && cardHref.test(a.getAttribute("href"))) {
        return a.getAttribute("aria-label");
      }
    }
    return null;
  }

  function titleInDocument(title) {
    return !!title && normalizeText(stripDocumentTitle(document.title)).includes(normalizeText(title));
  }

  // === SOURCE 3: DOM anchored on the page title ===============================

  function fromDom() {
    const title = listingTitleFromDoc();
    if (!title) return null;

    const titleEl = findElementByText(title);
    const price = titleEl ? priceNearElement(titleEl) : null;

    return {
      via: "dom",
      title,
      price,
      description: longestDetailText(),
      condition: labeledValueDom("Condition"),
      location: locationFromDom(),
      // Deliberately NO images from the DOM. On a real listing page the biggest
      // <img> elements are just as often ads, "more like this" thumbnails, or
      // banners (a Chevy ad, stock scenery, etc.) as the listing's own photos —
      // and feeding those to Claude reads as a mismatched/scam listing and
      // produces a false "Avoid". Real photos come only from the canonical
      // JSON listing_photos.
    };
  }

  // document.title tracks the open listing across in-app navigation.
  function listingTitleFromDoc() {
    const t = stripDocumentTitle(document.title);
    if (!t) return null;
    if (/^(marketplace|facebook|facebook marketplace|search results|buy and sell)/i.test(t)) {
      return null;
    }
    return t;
  }

  // In-app: "(1) Marketplace - <title> | Facebook". After a reload: "<title>".
  function stripDocumentTitle(raw) {
    return (raw || "")
      .replace(/^\(\d+\)\s*/, "") // "(7) "
      .replace(/\s*\|\s*Facebook.*$/i, "") // "| Facebook ..."
      .replace(/\s*[-–—]\s*Facebook\b.*$/i, "") // "- Facebook Marketplace"
      .replace(/^Marketplace\s*[-–—|]\s*/i, "") // "Marketplace - "
      .trim();
  }

  // Facebook's full DOM has thousands of span/div nodes; scanning it on every
  // settle-loop read is slow. Search the listing's main region first and only
  // fall back to the whole document if needed — fast in the common case,
  // still correct if FB nests the content elsewhere.
  function searchRoots() {
    const main = document.querySelector('div[role="main"]');
    return main ? [main, document] : [document];
  }

  function findElementByText(text) {
    const target = normalizeText(text);
    for (const root of searchRoots()) {
      for (const el of root.querySelectorAll('h1, h2, [role="heading"]')) {
        if (normalizeText(el.textContent) === target) return el;
      }
      // Leaf-ish element exactly matching (FB often renders the title in a span).
      for (const el of root.querySelectorAll("span, div")) {
        if (el.childElementCount <= 1 && normalizeText(el.textContent) === target) return el;
      }
    }
    return null;
  }

  // The asking price renders right after the title. Climb a few ancestors from
  // the title element; in each, return the first price-shaped text node that
  // comes AFTER the title (so a price sitting above the title can't win).
  function priceNearElement(titleEl) {
    let scope = titleEl.parentElement;
    for (let i = 0; i < 6 && scope; i += 1, scope = scope.parentElement) {
      const price = firstPriceAfter(scope, titleEl);
      if (price) return price;
    }
    return null;
  }

  function firstPriceAfter(scope, titleEl) {
    const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT, null);
    let passedTitle = false;
    let node;
    while ((node = walker.nextNode())) {
      if (!passedTitle) {
        if (titleEl.contains(node)) passedTitle = true;
        continue;
      }
      const txt = node.textContent.trim();
      if (txt.length > 25) continue; // skip prose that merely mentions a price
      if (/^free$/i.test(txt)) return txt;
      const m = txt.match(PRICE_RE);
      if (m) return m[0];
    }
    return null;
  }

  function labeledValueDom(label, scope) {
    for (const root of scope ? [scope] : searchRoots()) {
      for (const el of root.querySelectorAll("span, div")) {
        const t = el.textContent?.trim() ?? "";
        if (
          el.childElementCount <= 2 &&
          t.startsWith(label) &&
          t.length < 80 &&
          t.length > label.length
        ) {
          return t.slice(label.length).replace(/^[\s:·–-]+/, "").trim() || null;
        }
      }
    }
    return null;
  }

  function locationFromDom(scope = document.body) {
    const m = scope.textContent.match(/Listed[^·\n]*?\bin\s+([A-Z][\w\s.,'-]{2,40})/);
    return m ? m[1].trim() : null;
  }

  function longestDetailText(
    scope = document.querySelector('div[role="main"]') || document.body
  ) {
    let best = null;
    for (const el of scope.querySelectorAll("span, div")) {
      if (el.childElementCount > 0) continue;
      const t = el.textContent?.trim() ?? "";
      if (t.length < 50) continue;
      if (PRICE_RE.test(t) && t.length < 60) continue;
      if (!best || t.length > best.length) best = t;
    }
    return best;
  }

  // === Vehicle / structured attributes =======================================
  // Only facts we can extract RELIABLY: year (from the title) and mileage
  // (from FB's "Driven X miles", anchored to the title's own container so a
  // neighboring listing's mileage can't leak in). Anything we can't pin down
  // is left out — Claude reads the rest from the description, and an absent
  // value is reported honestly rather than guessed.
  function extractAttributes(title, titleEl) {
    const attrs = {};

    const yearMatch = title && title.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
    if (yearMatch) attrs.year = yearMatch[1];

    const mileage = extractMileage(titleEl);
    if (mileage) attrs.mileage = mileage;

    return Object.keys(attrs).length > 0 ? attrs : null;
  }

  function extractMileage(titleEl) {
    // Anchor to the smallest ancestor of the title that mentions mileage —
    // that ancestor is the open listing's detail pane, never a sidebar item.
    const re = /Driven\s+([\d.,]{2,})\s*(miles|mi|km)\b/i;
    const scope = titleEl ? nearestScopeWithText(titleEl, re) : null;
    if (!scope) return null;
    const m = scope.textContent.match(re);
    if (!m) return null;
    const n = Number(m[1].replace(/[.,]/g, ""));
    if (!Number.isFinite(n) || n < 100) return null; // reject noise
    return `${n.toLocaleString("en-US")} ${/km/i.test(m[2]) ? "km" : "miles"}`;
  }

  function nearestScopeWithText(el, re) {
    let scope = el.parentElement;
    for (let i = 0; i < 8 && scope; i += 1, scope = scope.parentElement) {
      if (re.test(scope.textContent || "")) return scope;
    }
    return null;
  }

  // === Shared helpers =========================================================

  function formatAmount(amount, currency) {
    const sym =
      currency === "USD" || currency == null
        ? "$"
        : currency === "GBP"
          ? "£"
          : currency === "EUR"
            ? "€"
            : "";
    return `${sym}${amount}`;
  }

  function normalizeText(s) {
    return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  // === Message interface ======================================================

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
