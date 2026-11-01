// Reading text from Facebook's page: price shapes, page title cleanup, and
// finding elements by their text. Used by every page source.
// Classic script (no ES modules in content scripts): shares window.__dealscan.

(() => {
  window.__dealscan ??= {};

  const PRICE_RE = /(?:CA\$|A\$|\$|£|€)\s?\d[\d,]*(?:\.\d{2})?/;

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

  function normalizeText(s) {
    return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  Object.assign(window.__dealscan, { PRICE_RE, stripDocumentTitle, searchRoots, findElementByText, priceNearElement, firstPriceAfter, normalizeText });
})();
