// Turning scraped strings into clean values. Pure logic, no chrome.* calls.

/** "$1,234.56" → 1234.56, "Free" → 0. Returns null when unparseable. */
export function parsePrice(text) {
  if (text == null) return null;
  if (/^\s*free\s*$/i.test(String(text))) return 0;
  const m = String(text).match(/\d[\d,]*(?:\.\d{1,2})?/);
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
