// Runs INSIDE a page (with the page's own scripts disabled) to turn a saved
// Facebook page into a fake one with the same structure.
//
// Default deny: all text, IDs, URLs, and attributes are replaced or removed unless
// they're on a short list of Facebook's own labels. So a name nobody thought of
// still gets replaced. The same original always gets the same fake, which keeps
// the title in the panel, the page title, and the search card in agreement.

export const FAKE_ITEM_ID_PREFIX = "900000";
export const FAKE_PROFILE_ID_PREFIX = "800000";
export const FAKE_PHOTO_HOST = "scontent.fake.fbcdn.net";

export function sanitizeInPage({ itemId, itemPrefix, profilePrefix, photoHost }) {
  const LABELS = new Set(
    [
      "Marketplace", "Facebook", "Condition", "Details", "Description", "Location",
      "Seller information", "Seller details", "Message", "Send", "Save", "Share",
      "See more", "See less", "Free", "New", "Used", "Used - like new", "Used - good", "Used - fair",
    ].map((label) => label.toLowerCase())
  );
  const PRICE = /^(?:CA\$|A\$|\$|£|€)\s?\d[\d,]*(?:\.\d{2})?$/;
  const KEEP_ATTRIBUTES = new Set(["role", "href", "src", "aria-label"]);

  const fakes = new Map(); // exact original text -> fake
  const originals = new Set(); // everything replaced, for the leak check
  const labelsKept = new Set();
  const itemIds = new Map();
  const profileIds = new Map();
  let counter = 0;

  const pad = (n) => String(n).padStart(4, "0");
  const fakeItemId = (id) => {
    if (!itemIds.has(id)) itemIds.set(id, `${itemPrefix}${pad(itemIds.size + 1)}`);
    originals.add(id);
    return itemIds.get(id);
  };
  const fakeProfileId = (id) => {
    if (!profileIds.has(id)) profileIds.set(id, `${profilePrefix}${pad(profileIds.size + 1)}`);
    originals.add(id);
    return profileIds.get(id);
  };

  function fakeFor(text) {
    const n = ++counter;
    if (PRICE.test(text)) return `$${(100 + n).toLocaleString("en-US")}`;
    if (/^Driven\s+[\d.,]+\s*(miles|mi|km)\b/i.test(text)) return `Driven ${(10000 + n).toLocaleString("en-US")} miles`;
    if (/^Listed\b.*\bin\s+/.test(text)) return "Listed recently in Fakeville";
    if (text.length < 50) return `Faketext ${n}`;
    // Long text stays long, because the scraper picks the longest as the description.
    const words = `Fakeprose ${n} `.repeat(Math.ceil(Math.min(text.length, 500) / 12));
    return words.trim();
  }

  function fake(raw) {
    const text = raw.replace(/\s+/g, " ").trim();
    if (!text) return raw;
    if (LABELS.has(text.toLowerCase())) {
      labelsKept.add(text);
      return text;
    }
    if (!fakes.has(text)) {
      fakes.set(text, fakeFor(text));
      originals.add(text);
    }
    return fakes.get(text);
  }

  // --- Page title: keep Facebook's frame, replace what's inside it ---------------
  const rawTitle = document.title;
  const frame = rawTitle.match(/^(\(\d+\)\s*)?(Marketplace\s*[-–—|]\s*)?(.*?)(\s*\|\s*Facebook.*)?$/s);
  const fakeTitle = `${frame[1] ? "(1) " : ""}${frame[2] ? "Marketplace - " : ""}${fake(frame[3])}${frame[4] ? " | Facebook" : ""}`;

  // --- Embedded data: rebuild only this listing, from named fields -----------------
  function parseBlob(text) {
    try {
      return JSON.parse(text);
    } catch {
      /* not pure JSON: try from the first brace */
    }
    try {
      return JSON.parse(text.slice(text.indexOf("{")));
    } catch {
      return null;
    }
  }

  // Every object with this listing's id, in scripts that mention the id and `field`.
  function* copiesOfListing(field) {
    for (const script of document.querySelectorAll("script")) {
      const text = script.textContent;
      if (!text.includes(itemId) || !text.includes(field)) continue;
      const stack = [parseBlob(text)];
      for (let steps = 0; stack.length > 0 && steps < 400000; steps++) {
        const node = stack.pop();
        if (!node || typeof node !== "object") continue;
        if (node.id === itemId) yield node;
        stack.push(...Object.values(node).filter((v) => v && typeof v === "object"));
      }
    }
  }

  function findListingNode() {
    for (const node of copiesOfListing("marketplace_listing_title")) {
      if (node.marketplace_listing_title != null || node.listing_price != null) return node;
    }
    return null;
  }

  // Facebook can embed the listing more than once, and the scraper takes photos
  // from whichever copy lists the most, so the fixture keeps that many.
  function photoCount() {
    let most = 0;
    for (const node of copiesOfListing("_photo")) {
      const listed = Array.isArray(node.listing_photos) ? node.listing_photos.length : 0;
      most = Math.max(most, listed || (node.primary_listing_photo ? 1 : 0));
    }
    return Math.min(most, 6);
  }

  const photoUrl = (n) => `https://${photoHost}/fake-${n}.jpg`;
  const node = findListingNode();
  let embedded = null;
  if (node) {
    const textOf = (value) => (typeof value === "string" ? fake(value) : null);
    const price = node.listing_price;
    embedded = {
      id: fakeItemId(itemId),
      marketplace_listing_title: textOf(node.marketplace_listing_title ?? node.custom_title),
      listing_price: price ? { formatted_amount: textOf(price.formatted_amount ?? String(price.amount ?? "")) } : null,
      redacted_description: { text: textOf(node.redacted_description?.text) },
      condition: textOf(node.condition?.text ?? node.condition),
      location_text: { text: textOf(node.location_text?.text) },
      listing_photos: Array.from({ length: photoCount() }, (_, i) => ({ image: { uri: photoUrl(`json-${i + 1}`) } })),
    };
  }

  // --- Remove everything that isn't structure -----------------------------------
  const REMOVE = "script, style, link, meta, base, noscript, iframe, object, embed, template, svg, video, audio, canvas, input, textarea, select, form";
  document.querySelectorAll(REMOVE).forEach((el) => el.remove());
  const comments = document.createTreeWalker(document, NodeFilter.SHOW_COMMENT);
  const toRemove = [];
  while (comments.nextNode()) toRemove.push(comments.currentNode);
  toRemove.forEach((c) => c.remove());

  // --- Links: only the shapes the scraper needs, with fake IDs ----------------------
  function fakeHref(href) {
    let url;
    try {
      url = new URL(href, "https://www.facebook.com");
    } catch {
      return "#";
    }
    const item = url.pathname.match(/\/marketplace\/item\/(\d+)/);
    if (item) return `/marketplace/item/${fakeItemId(item[1])}/`;
    const productId = url.searchParams.get("product_id");
    const profile = url.pathname.match(/\/marketplace\/profile\/([^/]+)/);
    if (profile) originals.add(profile[1]);
    if (productId && /^\d+$/.test(productId)) {
      const owner = profile ? fakeProfileId(profile[1]) : `${profilePrefix}0000`;
      return `/marketplace/profile/${owner}/?product_id=${fakeItemId(productId)}`;
    }
    return "#";
  }

  // A search card's label is "<title>, <price>, <location>, listing <id>". Titles
  // can hold commas, so known text is swapped first, longest first, and only then
  // is whatever remains split up and replaced.
  function fakeCardLabel(label, anchor) {
    for (const leaf of anchor.querySelectorAll("*")) {
      if (leaf.childElementCount === 0 && leaf.textContent.trim()) fake(leaf.textContent);
    }
    let out = label;
    const generated = new Set(fakes.values());
    for (const [original, replacement] of [...fakes].sort((a, b) => b[0].length - a[0].length)) {
      if (original.length >= 3) out = out.split(original).join(replacement);
    }
    return out
      .split(", ")
      .map((part) => {
        const id = part.match(/^listing (\d+)$/);
        if (id) return `listing ${fakeItemId(id[1])}`;
        return generated.has(part) || LABELS.has(part.toLowerCase()) ? part : fake(part);
      })
      .join(", ");
  }

  // Anchors first, so card labels see the original text before it's replaced.
  let photo = 0;
  for (const el of document.querySelectorAll("*")) {
    const label = el.getAttribute("aria-label");
    const href = el.tagName === "A" ? el.getAttribute("href") : null;
    const isCard = label && href && /\/marketplace\/item\/\d+/.test(href);

    if (isCard) el.setAttribute("aria-label", fakeCardLabel(label, el));
    else if (label) el.setAttribute("aria-label", fake(label));
    if (href != null) el.setAttribute("href", fakeHref(href));
    if (el.tagName === "IMG") el.setAttribute("src", photoUrl(++photo));

    for (const { name } of [...el.attributes]) {
      const allowed =
        KEEP_ATTRIBUTES.has(name) &&
        (name !== "href" || el.tagName === "A") &&
        (name !== "src" || el.tagName === "IMG");
      if (!allowed) el.removeAttribute(name);
    }
  }

  // --- Text ---------------------------------------------------------------------
  document.title = "";
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  const textNodes = [];
  while (walker.nextNode()) textNodes.push(walker.currentNode);
  for (const textNode of textNodes) textNode.nodeValue = fake(textNode.nodeValue);

  // --- Put the rebuilt parts back ----------------------------------------------------
  document.head.replaceChildren();
  const title = document.createElement("title");
  title.textContent = fakeTitle;
  document.head.append(title);
  if (embedded) {
    const script = document.createElement("script");
    script.type = "application/json";
    script.textContent = JSON.stringify({ listing: embedded });
    document.head.append(script);
  }

  return {
    html: document.documentElement.outerHTML,
    fakeItemId: fakeItemId(itemId),
    originals: [...originals],
    labelsKept: [...labelsKept].sort(),
    replacedCount: originals.size,
  };
}
