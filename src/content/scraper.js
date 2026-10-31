// DealScan scraper — runs inside facebook.com/marketplace pages.
//
// RELIABILITY MODEL
// Facebook is a single-page app that bundles many listings into one page
// (search results, "more like this", the open listing) and loads listing data
// dynamically. A naive "first price / biggest font" read can lock onto the
// WRONG item; relying only on embedded JSON refuses too often (the JSON isn't
// present after in-app navigation). So we use THREE sources, and EVERY one is
// verified to belong to the listing in the URL before we trust it:
//
//   1. Embedded JSON  — walked to the object whose `id` === the URL item id.
//   2. Meta tags      — trusted only when og:url contains that same item id.
//   3. DOM            — title taken from the page title (which tracks the open
//                       listing), price read from the element next to it.
//
// Each source returns the same shape; we coalesce field-by-field by priority.
// Because all three are pinned to the current item id / page title, a value
// can never come from a neighboring listing. Only when NO source yields both a
// title and a price do we mark confidence "low" — the panel then refuses
// rather than guess.
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

    // Build each source independently (any may be null). Priority order:
    // verified JSON → verified meta → page-title-anchored DOM.
    const jsonNode = itemId ? findListingNode(itemId) : null;
    const sources = [
      jsonNode ? sourceFromJson(jsonNode) : null,
      fromMeta(itemId),
      fromDom(),
    ].filter(Boolean);

    const pick = (field) => {
      for (const s of sources) {
        if (s[field] != null && s[field] !== "") return s[field];
      }
      return null;
    };
    // Merge photos across sources so a single-photo meta source can't cap us
    // at one image. Canonical JSON photos first, then meta's primary — deduped.
    // We never scavenge arbitrary page <img>s (they pull in ads/rails and
    // poison the evaluation), so only these two verified sources contribute.
    const mergeImages = () => {
      const byVia = {};
      for (const s of sources) byVia[s.via] = Array.isArray(s.images) ? s.images : [];
      const seen = new Set();
      const out = [];
      for (const via of ["json", "meta"]) {
        for (const u of byVia[via] || []) {
          if (!seen.has(u)) {
            seen.add(u);
            out.push(u);
          }
        }
      }
      return out.slice(0, 6);
    };

    const title = pick("title");
    const price = pick("price");
    const confidence = title && price ? "high" : "low";

    // "verified" = an item-id-pinned source (JSON or meta) supplied BOTH the
    // title and price. Those sources only return data for THIS item, so they
    // can't be stale from a previous listing. The DOM source isn't pinned, so
    // right after an in-app click it can briefly hold the old listing — the
    // side panel waits for a verified or stable read before trusting it.
    const verified = sources.some(
      (s) => (s.via === "json" || s.via === "meta") && s.title && s.price
    );

    // True when the page's og:url still names a DIFFERENT item than the URL —
    // i.e. Facebook hasn't finished swapping to the clicked listing yet.
    const transitioning = isTransitioning(itemId);

    // Vehicle facts (mileage/year) — extracted reliably and sent as explicit
    // fields so pricing never depends on the messy free-text description.
    const titleEl = title ? findElementByText(title) : null;
    const attributes = extractAttributes(title, titleEl);

    const data = {
      url: location.href,
      confidence,
      verified,
      transitioning,
      title,
      price,
      description: pick("description"),
      condition: pick("condition"),
      location: pick("location"),
      attributes,
      images: mergeImages(),
    };

    // Lightweight diagnostics so failures are reportable from the page console.
    try {
      console.debug("[DealScan] scrape", {
        itemId,
        confidence,
        verified,
        transitioning,
        title,
        price,
        via: sources.map((s) => s.via),
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
      via: "json",
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

  // === SOURCE 2: meta tags (og:url-verified) ==================================

  function fromMeta(itemId) {
    const ogUrl = metaContent("og:url");
    // Trust meta ONLY if it's for this exact item (handles stale tags after
    // in-app navigation, where og:url still points at the first-loaded item).
    if (!itemId || !ogUrl || !ogUrl.includes(itemId)) return null;

    const title = cleanTitleString(metaContent("og:title"));
    if (!title) return null;

    const amount = metaContent("product:price:amount") || metaContent("og:price:amount");
    const currency =
      metaContent("product:price:currency") || metaContent("og:price:currency") || "USD";
    const image = metaContent("og:image");

    return {
      via: "meta",
      title,
      price: amount ? formatAmount(amount, currency) : null,
      description: metaContent("og:description"),
      condition: null,
      location: null,
      images: image && /^https:\/\//.test(image) ? [image] : [],
    };
  }

  function metaContent(prop) {
    const el =
      document.querySelector(`meta[property="${prop}"]`) ||
      document.querySelector(`meta[name="${prop}"]`);
    const content = el?.getAttribute("content");
    return content && content.trim() ? content.trim() : null;
  }

  // After an in-app click, og:url can still point at the previously-open item
  // for a beat. If it names a DIFFERENT item id than the URL, the page is
  // mid-swap and DOM reads aren't trustworthy yet.
  function isTransitioning(itemId) {
    const ogUrl = metaContent("og:url");
    const m = ogUrl && ogUrl.match(/\/item\/(\d+)/);
    return !!(m && itemId && m[1] !== itemId);
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
      // JSON listing_photos and the verified meta og:image.
      images: [],
    };
  }

  // document.title tracks the open listing across in-app navigation; og:title
  // is a fallback for the initial load.
  function listingTitleFromDoc() {
    return cleanTitleString(document.title) || cleanTitleString(metaContent("og:title"));
  }

  function cleanTitleString(raw) {
    if (!raw) return null;
    let t = raw
      .replace(/^\(\d+\)\s*/, "") // "(7) "
      .replace(/\s*\|\s*Facebook.*$/i, "") // "| Facebook ..."
      .replace(/\s*[-–—]\s*Facebook\b.*$/i, "") // "- Facebook Marketplace"
      .replace(/^Marketplace\s*[-–—|]\s*/i, "") // "Marketplace - "
      .trim();
    if (!t) return null;
    if (/^(marketplace|facebook|facebook marketplace|search results|buy and sell)/i.test(t)) {
      return null;
    }
    return t;
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
      const m = txt.match(PRICE_RE);
      if (m) return m[0];
    }
    return null;
  }

  function labeledValueDom(label) {
    for (const root of searchRoots()) {
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

  function locationFromDom() {
    const m = document.body.textContent.match(/Listed[^·\n]*?\bin\s+([A-Z][\w\s.,'-]{2,40})/);
    return m ? m[1].trim() : null;
  }

  function longestDetailText() {
    let best = null;
    const scope =
      document.querySelector('div[role="main"]') || document.querySelector("body");
    if (!scope) return null;
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
