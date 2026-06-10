// Listing parser for DealScan.
//
// Takes the raw best-effort scrape from content/scraper.js and normalizes it
// into the clean schema the rest of the extension relies on. All downstream
// code (Claude prompt, storage, UI) consumes ONLY parsed listings.

import { detectCategory } from "./categories.js";

/**
 * Normalize a raw scraped listing.
 * @param {object} raw - output of scraper.js scrapeListing().
 * @returns {object} clean listing schema.
 * @throws if the scrape is unusable (no title and no price).
 */
export function parseListing(raw) {
  if (!raw) throw new Error("Nothing scraped from the page.");

  const title = cleanText(raw.title);
  const priceNumber = parsePrice(raw.price);

  if (!title && priceNumber == null) {
    throw new Error(
      "Couldn't read this listing — Facebook may have changed their page layout. Try refreshing."
    );
  }

  const description = cleanText(raw.description);

  return {
    url: stripTracking(raw.url),
    scrapedAt: raw.scrapedAt ?? Date.now(),
    title: title ?? "(untitled listing)",
    price: priceNumber,
    priceRaw: raw.price ?? null,
    currency: parseCurrency(raw.price),
    condition: cleanText(raw.condition),
    description,
    location: cleanText(raw.location),
    seller: cleanText(raw.seller),
    images: Array.isArray(raw.images) ? raw.images : [],
    category: detectCategory(`${title ?? ""} ${description ?? ""}`),
  };
}

/** "$1,234.56" → 1234.56. Returns null when unparseable. */
export function parsePrice(text) {
  if (!text) return null;
  const m = String(text).match(/[\d,]+(?:\.\d{2})?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Extract the currency symbol from a raw price string. Defaults to "$". */
export function parseCurrency(text) {
  if (!text) return "$";
  const m = String(text).match(/CA\$|A\$|[$£€]/);
  return m ? m[0] : "$";
}

/** Collapse whitespace; return null for empty/junk values. */
export function cleanText(text) {
  if (typeof text !== "string") return null;
  const cleaned = text.replace(/\s+/g, " ").trim();
  return cleaned.length > 0 ? cleaned : null;
}

/** Drop query params/fragments so the same listing always has the same URL key. */
export function stripTracking(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return url;
  }
}
