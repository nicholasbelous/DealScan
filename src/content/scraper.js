// DealScan scraper — runs inside facebook.com/marketplace pages.
//
// RELIABILITY MODEL (this is the whole point of the rewrite):
// Facebook bundles many listings into one page (search results, "more like
// this", the open listing). Any heuristic like "first price" or "biggest font"
// can lock onto the WRONG item. So we trust exactly ONE source:
//
//   Facebook's embedded JSON, walked to the single object whose `id` equals
//   the item ID in the URL. Title, price, description, location, AND images
//   all come from that one verified object — so they cannot belong to a
//   different listing.
//
// If we can't find that object (FB changed their structure, page still
// loading), we report confidence "low" and DO NOT guess. The side panel then
// refuses to evaluate rather than risk a wrong verdict.
//
// Classic script (no ES modules in content scripts). Exposes one message:
//   { type: "SCRAPE_LISTING" } → { ok, data: rawListing }

(() => {
  // Guard against double injection (the panel re-injects on demand).
  if (window.__dealscanScraper) return;
  window.__dealscanScraper = true;

  function scrapeListing() {
    const itemId = currentItemId();
    const node = itemId ? findListingNode(itemId) : null;

    if (!node) {
      // No verified data → low confidence. We deliberately do NOT fall back to
      // DOM scraping; the panel will refuse rather than evaluate wrong data.
      return {
        url: location.href,
        itemId,
        scrapedAt: Date.now(),
        confidence: "low",
        title: titleFromTabAsHint(),
        price: null,
        description: null,
        condition: null,
        location: null,
        seller: null,
        images: [],
      };
    }

    return {
      url: location.href,
      itemId,
      scrapedAt: Date.now(),
      confidence: "high",
      title: node.marketplace_listing_title ?? node.custom_title ?? null,
      price: extractPrice(node.listing_price),
      description: node.redacted_description?.text ?? null,
      condition: conditionText(node),
      location: locationText(node),
      seller: sellerName(node),
      images: collectImageUrls(node),
    };
  }

  function currentItemId() {
    const m = location.pathname.match(/\/marketplace\/item\/(\d+)/);
    return m ? m[1] : null;
  }

  // --- Find the one verified listing object -----------------------------------

  function findListingNode(itemId) {
    for (const script of document.querySelectorAll('script[type="application/json"]')) {
      const text = script.textContent;
      // Cheap pre-filters before the expensive JSON.parse: the blob must
      // mention this item AND carry listing fields.
      if (!text || !text.includes(itemId) || !text.includes("marketplace_listing_title")) {
        continue;
      }
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        continue;
      }
      const node = walkForListing(data, itemId);
      if (node) return node;
    }
    return null;
  }

  // Depth-first search for the listing object: matching id AND listing fields.
  // (Other objects reuse the id — tracking refs, comments — so we require a
  // listing-specific field to be sure we have the real thing.)
  function walkForListing(root, itemId) {
    const stack = [root];
    let steps = 0;
    while (stack.length > 0 && steps < 300000) {
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

  // --- Field extractors (all read from the verified node only) ----------------

  function extractPrice(listingPrice) {
    if (!listingPrice || typeof listingPrice !== "object") return null;
    if (listingPrice.formatted_amount) return listingPrice.formatted_amount;
    if (listingPrice.amount != null) {
      const cur = listingPrice.currency === "USD" ? "$" : "";
      return `${cur}${listingPrice.amount}`;
    }
    return null;
  }

  function conditionText(node) {
    // FB stores condition in a few shapes across page versions.
    return (
      node.condition?.text ??
      node.condition ??
      node.attribute_data?.find?.((a) => /condition/i.test(a?.label ?? ""))?.value ??
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

  function sellerName(node) {
    return (
      node.marketplace_listing_seller?.name ??
      node.story?.actors?.[0]?.name ??
      node.seller?.name ??
      null
    );
  }

  // Collect ONLY the listing's actual photos, from FB's canonical photo
  // fields, in display order. We deliberately do NOT scavenge the node for
  // any image-looking URL — that picks up seller avatars, category icons, and
  // blurred preview thumbnails, which then read as "placeholder images" and
  // poison the evaluation. No canonical photos found → return none; a
  // text-only evaluation beats one based on the wrong images.
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

  // Only used as a soft hint in the low-confidence payload (not for scoring).
  function titleFromTabAsHint() {
    const t = document.title
      .replace(/^\(\d+\)\s*/, "")
      .replace(/^Marketplace\s*[-–—]\s*/i, "")
      .replace(/\s*\|\s*Facebook\s*$/i, "")
      .trim();
    return t && !/^(marketplace|facebook|search results)$/i.test(t) ? t : null;
  }

  // --- Message interface ------------------------------------------------------

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
