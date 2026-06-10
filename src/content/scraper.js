// DealScan scraper — runs inside facebook.com/marketplace/item/* pages.
//
// Facebook obfuscates its CSS classes (e.g. "x1lliihq"), so we never rely on
// class names. Instead we use stable signals: semantic elements (h1), ARIA
// landmarks, meta tags, and text patterns (currency regex). Every field is
// best-effort — missing data is returned as null and handled downstream.
//
// Classic script (no ES modules in content scripts). Exposes one message:
//   { type: "SCRAPE_LISTING" } → { ok, data: rawListing }

(() => {
  const PRICE_RE = /(?:\$|£|€|CA\$|A\$)\s?[\d,]+(?:\.\d{2})?/;

  function scrapeListing() {
    const main = document.querySelector('div[role="main"]') || document.body;

    const title = getTitle(main);
    return {
      url: location.href,
      scrapedAt: Date.now(),
      title,
      price: getPrice(main, title),
      description: getDescription(main),
      condition: getLabeledValue(main, "Condition"),
      location: getLocation(main),
      seller: getSeller(main),
      images: getImages(main),
    };
  }

  function getTitle(main) {
    // The listing title is the page's only h1 inside the main region.
    const h1 = main.querySelector("h1") || document.querySelector("h1");
    const text = h1?.textContent?.trim();
    if (text) return text;
    // Fallback: og:title meta ("<title> - Marketplace" suffix stripped).
    const og = document.querySelector('meta[property="og:title"]')?.content;
    return og ? og.replace(/\s*[|-]\s*Marketplace.*$/i, "").trim() : null;
  }

  function getPrice(main, title) {
    // The price renders as a standalone text node near the title, e.g. "$450"
    // or "$1,200 · In stock". Walk spans/divs after the h1 and take the first
    // currency match that isn't part of the description body.
    const h1 = main.querySelector("h1");
    const scope = h1?.closest('div[role="main"]') || main;
    const candidates = scope.querySelectorAll("span, div");
    for (const el of candidates) {
      // Only leaf-ish nodes — avoids matching huge container text blobs.
      if (el.children.length > 1) continue;
      const text = el.textContent?.trim() ?? "";
      if (text.length > 40) continue;
      if (title && text === title) continue;
      const m = text.match(PRICE_RE);
      if (m) return m[0];
    }
    return null;
  }

  function getDescription(main) {
    // FB truncates with a "See more" toggle; the full text is still in the
    // DOM. Heuristic: the longest text block in main that isn't the comments
    // section and is longer than ~40 chars.
    let best = null;
    for (const el of main.querySelectorAll("span, div")) {
      if (el.children.length > 0) continue; // leaf text nodes only
      const text = el.textContent?.trim() ?? "";
      if (text.length < 40) continue;
      if (PRICE_RE.test(text) && text.length < 60) continue;
      if (!best || text.length > best.length) best = text;
    }
    return best;
  }

  function getLabeledValue(main, label) {
    // Detail rows render as "Label\nValue" pairs, e.g. "Condition Used – Good".
    for (const el of main.querySelectorAll("span, div")) {
      const text = el.textContent?.trim() ?? "";
      if (text.startsWith(label) && text.length < 80 && text.length > label.length) {
        return text.slice(label.length).replace(/^[\s:·-]+/, "").trim() || null;
      }
    }
    return null;
  }

  function getLocation(main) {
    // Location appears as a link to /marketplace/<city-slug>/.
    const link = main.querySelector('a[href*="/marketplace/"][href*="latitude"], a[href^="/marketplace/category"], a[href*="/marketplace/1"]');
    const guess = link?.textContent?.trim();
    if (guess && guess.length < 60) return guess;
    // Fallback: "Listed 2 days ago in Springfield, IL" pattern.
    const m = main.textContent.match(/Listed[^·\n]*?\bin\s+([A-Z][\w\s.,'-]{2,40})/);
    return m ? m[1].trim() : null;
  }

  function getSeller(main) {
    // Seller name is a profile link near the "Seller information" heading.
    const sellerLink = main.querySelector('a[href*="/marketplace/profile/"], a[href*="facebook.com/profile"]');
    const text = sellerLink?.textContent?.trim();
    return text && text.length < 60 ? text : null;
  }

  function getImages(main) {
    const urls = new Set();
    for (const img of main.querySelectorAll("img")) {
      const src = img.src || "";
      // Listing photos come from FB's scontent CDN; skip avatars/emoji (tiny).
      if (src.includes("scontent") && img.naturalWidth >= 200) {
        urls.add(src);
      }
    }
    return [...urls].slice(0, 10);
  }

  // --- Message interface -------------------------------------------------------

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
