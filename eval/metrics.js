// What the eval reports. Pure: takes per-listing results, returns numbers.
// A metric with nothing to measure is null, never 0.

import { median, p90 } from "../src/shared/stats.js";

const rate = (hits, total) => ({ hits, total, rate: total > 0 ? hits / total : null });

/** How often my price range overlaps the model's, on each listing's first run. */
export function priceRangeHitRate(results) {
  const scored = results.filter((r) => r.label.readable && r.runs[0]?.status === "valid");
  const hits = scored.filter(({ label, runs }) => {
    const { marketLow, marketHigh } = runs[0].verdict;
    return label.human_price_low <= marketHigh && marketLow <= label.human_price_high;
  });
  return rate(hits.length, scored.length);
}

/** How much the score moves when the same listing is evaluated repeatedly. */
export function scoreVariance(results, runsPerListing) {
  const listings = results
    .filter((r) => r.runs.length === runsPerListing)
    .map((r) => {
      const scores = r.runs.filter((run) => run.status === "valid").map((run) => run.verdict.score);
      return {
        itemId: r.label.item_id,
        scores,
        spread: scores.length > 0 ? Math.max(...scores) - Math.min(...scores) : null,
      };
    });
  const spreads = listings.map((l) => l.spread);
  return { listings, medianSpread: median(spreads), maxSpread: spreads.some(Number.isFinite) ? Math.max(...spreads.filter(Number.isFinite)) : null };
}

/**
 * Of the listings rejected at least once, how many my labels call unreadable.
 * Covers rejected model answers in this run. Gate rejections are logged locally
 * in the browser (exportable from Options) and aren't read here yet.
 */
export function rejectionPrecision(results) {
  const rejected = results.filter((r) => r.runs.some((run) => run.status === "rejected"));
  return {
    ...rate(rejected.filter((r) => !r.label.readable).length, rejected.length),
    scope: "rejected model answers only; the extension's gate rejection log isn't included",
  };
}

/** Every call that reached the API counts, including retries and rejections. */
export function costAndLatency(results) {
  const runs = results.flatMap((r) => r.runs).filter((run) => run.evaluation?.attempts > 0);
  const costs = runs.map((run) => run.evaluation.costUsd);
  const latencies = runs.map((run) => run.evaluation.latencyMs);
  return {
    runs: runs.length,
    costUsd: { median: median(costs), p90: p90(costs), total: costs.reduce((sum, c) => sum + (c ?? 0), 0) },
    latencyMs: { median: median(latencies), p90: p90(latencies) },
  };
}
