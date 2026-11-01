// Aggregates for GET /v1/stats. Pure: takes rows, returns numbers.

import { median, p90 } from "../../src/shared/stats.js";

const WINDOWS_MS = { "24h": 86_400_000, "7d": 604_800_000, "30d": 2_592_000_000 };

export const STATS_WINDOWS = [...Object.keys(WINDOWS_MS), "all"];

export function windowStart(window, now) {
  return window === "all" ? 0 : now - WINDOWS_MS[window];
}

const spread = (values) => ({ median: median(values), p90: p90(values) });

/**
 * Cost and latency only count work that reached the API, so cache hits and
 * budget refusals (which cost nothing) can't flatter the numbers. Retries and
 * rejected answers do count.
 */
export function buildStats(rows) {
  const billed = rows.filter((r) => !r.cache_hit && r.attempts > 0);
  const valid = rows.filter((r) => r.status === "valid");

  const reasons = new Map();
  for (const r of rows) {
    if (r.rejection_reason) reasons.set(r.rejection_reason, (reasons.get(r.rejection_reason) ?? 0) + 1);
  }

  return {
    total: rows.length,
    byStatus: {
      valid: valid.length,
      rejected: rows.filter((r) => r.status === "rejected").length,
      error: rows.filter((r) => r.status === "error").length,
    },
    topRejectionReasons: [...reasons]
      .map(([reason, count]) => ({ reason, count }))
      .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason))
      .slice(0, 10),
    costUsd: spread(billed.map((r) => r.cost_usd)),
    totalCostUsd: billed.reduce((sum, r) => sum + (r.cost_usd ?? 0), 0),
    latencyMs: spread(billed.map((r) => r.latency_ms)),
    cacheHitRate: valid.length > 0 ? valid.filter((r) => r.cache_hit).length / valid.length : null,
  };
}
