// Page source 1: embedded JSON, walked to the object whose `id` === the URL item
// id. Usually present after a full page load, and the only source of photos.
// Classic script (no ES modules in content scripts): shares window.__dealscan.

(() => {
  window.__dealscan ??= {};

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

  Object.assign(window.__dealscan, { findListingNode, sourceFromJson });
})();
