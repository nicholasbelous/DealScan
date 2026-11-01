// The reliability gate: whether a scraped read can be trusted. The side panel
// refuses to evaluate (and refuses to spend API credit) when a read fails it,
// rather than risk a verdict on the wrong listing. Pure logic, no chrome.* calls.

import { cleanText, parsePrice } from "./normalize.js";

/**
 * The reliability gate. A read is trusted only if a source tied to an item id
 * matches the item id in the URL, the page isn't mid-navigation, and the two
 * fields the verdict depends on are present. A read verified from the listing
 * panel must also agree with the page title and any search card for the item.
 * @param {object} raw - output of scraper.js scrapeListing().
 * @returns {{reliable: boolean, reason: string|null}} reason is user-facing.
 */
export function checkRead(raw) {
  const reject = (reason) => ({ reliable: false, reason });

  if (raw.transitioning) return reject("The page was still switching to this listing.");
  const urlItemId = itemIdFromUrl(raw.url);
  if (!urlItemId) return reject("This page's address doesn't include a listing ID.");
  if (!raw.verifiedItemId) return reject("Couldn't confirm the page data belongs to this listing.");
  if (raw.verifiedItemId !== urlItemId) return reject("The page data is for a different listing.");
  if (cleanText(raw.title) == null || parsePrice(raw.price) == null) {
    return reject("Couldn't find this listing's title and price.");
  }
  if (raw.verifiedBy === "panel_product_id") {
    if (raw.titleInDocument === false) return reject("The page title doesn't match this listing.");
    if (raw.feedCardLabel && !feedCardAgrees(raw.feedCardLabel, raw.title, raw.price)) {
      return reject("The search result for this listing shows a different title or price.");
    }
  }
  return { reliable: true, reason: null };
}

// A search card labeled "<title>, <price>, <location>, listing <id>". A price
// that can't be parsed from the label is no evidence either way.
function feedCardAgrees(label, title, price) {
  const normalized = cleanText(label).toLowerCase();
  const prefix = `${cleanText(title).toLowerCase()}, `;
  if (!normalized.startsWith(prefix)) return false;
  const cardPrice = parsePrice(normalized.slice(prefix.length).split(", ")[0]);
  return cardPrice == null || cardPrice === parsePrice(price);
}

export function itemIdFromUrl(url) {
  const m = String(url ?? "").match(/\/marketplace\/item\/(\d+)/);
  return m ? m[1] : null;
}
