// Listing parser for DealScan.
//
// Normalizes the raw scrape into the clean schema the rest of the extension
// uses, and records the reliability gate's decision (gate.js) on it.

import { detectCategory } from "./categories.js";
import { checkRead } from "./gate.js";
import { cleanText, parseCurrency, parsePrice } from "./normalize.js";

/**
 * Whether a cached verdict still applies. One made without photos is replaced
 * only if this read offers more photos than that evaluation had to work with,
 * e.g. a reload exposed the page's own data. Offering the same photos again
 * after they failed to download would just pay for the same answer.
 */
export function canReuseVerdict(cached, photosOffered) {
  return cached.imagesAnalyzed > 0 || photosOffered <= (cached.imagesOffered ?? 0);
}

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

  const { reliable, reason } = checkRead(raw);

  return {
    url: stripTracking(raw.url),
    reliable,
    rejectReason: reason,
    verifiedBy: reliable ? raw.verifiedBy ?? null : null,
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
