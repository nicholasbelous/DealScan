// Listing parser for DealScan.
//
// Normalizes the raw scrape into the clean schema the rest of the extension
// uses. Crucially it also surfaces a `reliable` flag derived from the
// scraper's confidence: the side panel refuses to evaluate (and refuses to
// spend API credit) when this is false, rather than risk a wrong verdict.

import { detectCategory } from "./categories.js";

/**
 * Normalize a raw scraped listing.
 * @param {object} raw - output of scraper.js scrapeListing().
 * @returns {object} clean listing schema, including `reliable`.
 */
export function parseListing(raw) {
  if (!raw) throw new Error("Nothing scraped from the page.");

  const title = cleanText(raw.title);
  const priceNumber = parsePrice(raw.price);
  const description = cleanText(raw.description);

  // Reliable only when the scraper verified the listing against the URL's
  // item ID AND we actually have the two fields the verdict depends on.
  const reliable =
    raw.confidence === "high" && title != null && priceNumber != null;

  return {
    url: stripTracking(raw.url),
    reliable,
    title: title ?? "(untitled listing)",
    price: priceNumber,
    priceRaw: raw.price ?? null,
    currency: parseCurrency(raw.price),
    condition: cleanText(raw.condition),
    description,
    location: cleanText(raw.location),
    attributes: cleanAttributes(raw.attributes),
    images: Array.isArray(raw.images) ? raw.images.filter(isHttpUrl) : [],
    category: detectCategory(`${title ?? ""} ${description ?? ""}`),
  };
}

/** "$1,234.56" → 1234.56. Returns null when unparseable. */
function parsePrice(text) {
  if (text == null) return null;
  const m = String(text).match(/[\d,]+(?:\.\d{1,2})?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Extract the currency symbol from a raw price string. Defaults to "$". */
function parseCurrency(text) {
  if (!text) return "$";
  const m = String(text).match(/CA\$|A\$|[$£€]/);
  return m ? m[0] : "$";
}

/** Collapse whitespace; return null for empty/junk values. */
function cleanText(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Drop query params/fragments so the same listing always has the same URL key. */
function stripTracking(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}

function isHttpUrl(value) {
  return typeof value === "string" && /^https:\/\//.test(value);
}

// Keep only string/number attribute values; drop empties. Returns null when
// nothing usable remains so the prompt can say "not listed" honestly.
function cleanAttributes(attributes) {
  if (!attributes || typeof attributes !== "object") return null;
  const out = {};
  for (const [key, value] of Object.entries(attributes)) {
    if (typeof value === "string" && value.trim()) out[key] = value.trim();
    else if (typeof value === "number" && Number.isFinite(value)) out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}
