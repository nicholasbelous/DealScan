// Display formatting helpers for DealScan's UI.

/** 1234.5 → "$1,235". Whole dollars — cents add noise at marketplace prices. */
export function formatMoney(amount, currency = "$") {
  if (amount == null || !Number.isFinite(Number(amount))) return "—";
  return `${currency}${Math.round(Number(amount)).toLocaleString("en-US")}`;
}

/** Timestamp → "Jun 10" this year, "Jun 10, 2025" otherwise. */
export function formatDate(timestamp) {
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

/** Truncate long text with an ellipsis for table cells / cards. */
export function truncate(text, max = 60) {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
