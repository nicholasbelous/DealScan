// Page source 2: the listing panel. The smallest container around a product_id
// link that also holds a title and price, and no links to other listings. Title,
// price, and ID all come from that one container. Works after in-app navigation.
//
// PRIVACY: product_id links are the seller's profile links. We extract only the
// product_id parameter and never read, keep, or log the rest of the URL.
// Classic script (no ES modules in content scripts): shares window.__dealscan.

(() => {
  window.__dealscan ??= {};
  const { firstPriceAfter, labeledValueDom, locationFromDom, longestDetailText, normalizeText, stripDocumentTitle } = window.__dealscan;

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

  Object.assign(window.__dealscan, { findListingPanel, sourceFromPanel, feedCardLabel, titleInDocument });
})();
