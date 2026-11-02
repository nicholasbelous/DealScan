// DealScan scraper. Loaded on every facebook.com page (see manifest.json), and
// reads the open listing only when the side panel asks.
//
// RELIABILITY MODEL
// Facebook is a single-page app that bundles many listings into one page
// (search results, "more like this", the open listing) and loads listing data
// dynamically. A naive "first price / biggest font" read can lock onto the
// WRONG item; relying only on embedded JSON refuses too often (the JSON isn't
// present after in-app navigation). So we use THREE sources:
//
//   1. source-embedded.js  embedded JSON, pinned to the URL's item id
//   2. source-panel.js     the listing panel, pinned by its product_id links
//   3. source-page.js      the page itself: not pinned, only fills gaps
//
// This file combines them and reports what it saw. The decision to trust the
// read is made in one place, checkRead() in src/shared/gate.js.
//
// Classic script (no ES modules in content scripts). Exposes one message:
//   { type: "SCRAPE_LISTING" } → { ok, data: rawListing }

(() => {
  // Guard against double injection (the panel re-injects on demand).
  if (window.__dealscanScraper) return;
  window.__dealscanScraper = true;

  const {
    extractAttributes,
    feedCardLabel,
    findElementByText,
    findListingNode,
    findListingPanel,
    fromDom,
    sourceFromJson,
    sourceFromPanel,
    titleInDocument,
  } = window.__dealscan;

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
        photos: data.images.length,
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
