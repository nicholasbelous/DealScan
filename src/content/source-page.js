// Page source 3: the page itself. Title from document.title, price from the
// element next to it. NOT tied to an item id, so it only fills gaps and can never
// make a read trustworthy alone.
// Classic script (no ES modules in content scripts): shares window.__dealscan.

(() => {
  window.__dealscan ??= {};
  const { findElementByText, labeledValueDom, locationFromDom, longestDetailText, priceNearElement, stripDocumentTitle } = window.__dealscan;

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

  Object.assign(window.__dealscan, { fromDom });
})();
