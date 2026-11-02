// Display formatting helpers for DealScan's UI.

/** 1234.5 → "$1,235". Whole dollars — cents add noise at marketplace prices. */
export function formatMoney(amount, currency = "$") {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  return `${currency}${Math.round(Number(amount)).toLocaleString("en-US")}`;
}

/** Evaluation cost in USD. Four decimals: these are fractions of a cent. */
export function formatCost(usd) {
  return Number.isFinite(usd) ? `$${usd.toFixed(4)}` : "—";
}

/** Timestamp → "Jun 10" this year, "Jun 10, 2025" otherwise. */
function formatDate(timestamp) {
  if (!timestamp) return "—";
  const d = new Date(timestamp);
  const opts = { month: "short", day: "numeric" };
  if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
  return d.toLocaleDateString("en-US", opts);
}

/** Timestamp → "just now" / "5m ago" / "3h ago" / "2d ago", else formatDate. */
export function formatRelative(timestamp) {
  if (!timestamp) return "—";
  const mins = Math.floor((Date.now() - timestamp) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(timestamp);
}

/** Map a 0-100 score to the CSS color used by the score ring and badges. */
export function scoreColor(score) {
  if (score == null) return "var(--muted)";
  if (score >= 85) return "var(--great)";
  if (score >= 70) return "var(--good)";
  if (score >= 50) return "var(--fair)";
  if (score >= 30) return "var(--poor)";
  return "var(--avoid)";
}

/**
 * Why a verdict had no photos, or null if it had some. Says which case it was:
 * photos off, none found in the page's data, or found but none downloaded.
 * Only a panel read can gain them by reloading.
 */
export function noPhotosNotice(verdict, verifiedBy) {
  if (verdict.imagesAnalyzed > 0) return null;
  if (verdict.photoAnalysisOn === false) return "Evaluated without photos: photo analysis is off in Options.";
  if (verifiedBy === "panel_product_id") return "Evaluated without photos: reload to include them.";
  if (verdict.imagesOffered === 0) return "Evaluated without photos: none were found in this page's listing data.";
  if (verdict.imagesOffered > 0) {
    const found = verdict.imagesOffered === 1 ? "1 photo was" : `${verdict.imagesOffered} photos were`;
    return `Evaluated without photos: ${found} found, but none could be downloaded.`;
  }
  return "Evaluated without photos."; // a cached result from before imagesOffered was recorded
}

/**
 * Where the asking price sits against the market range, for the "vs market"
 * cell. Inside the range there's no meaningful percentage, so it says so.
 * Outside it, the percent is savingsPercent: asking vs the range's midpoint.
 * @returns {{text: string, tone: "below"|"above"|"within"} | null}
 */
export function marketPosition(verdict) {
  const { askingPrice, marketLow, marketHigh, savingsPercent } = verdict;
  if (![askingPrice, marketLow, marketHigh].every(Number.isFinite) || marketHigh <= 0) return null;
  if (askingPrice >= marketLow && askingPrice <= marketHigh) return { text: "Within market range", tone: "within" };
  if (!Number.isFinite(savingsPercent)) return null;
  const tone = askingPrice < marketLow ? "below" : "above";
  return { text: `${Math.abs(Math.round(savingsPercent))}% ${tone}`, tone };
}

/** Truncate long text with an ellipsis for table cells / cards. */
export function truncate(text, max = 60) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
