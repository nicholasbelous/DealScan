// Summary statistics, shared by the History tab, the server, and the eval harness.

/** Nearest-rank percentile of finite numbers. Null when there are none. */
export function percentile(values, p) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  return sorted[Math.max(Math.ceil((p / 100) * sorted.length) - 1, 0)];
}

export const median = (values) => percentile(values, 50);
export const p90 = (values) => percentile(values, 90);

/** Median, p90, and total cost across usage records. Unknown costs are skipped. */
export function summarizeCost(records) {
  const costs = records.map((r) => r.costUsd).filter(Number.isFinite);
  if (costs.length === 0) return null;
  return {
    count: costs.length,
    median: median(costs),
    p90: p90(costs),
    total: costs.reduce((sum, c) => sum + c, 0),
  };
}
