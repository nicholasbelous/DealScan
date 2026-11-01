// Runs labeled listings through the current model and prompt. The caller passes
// `evaluate`, so tests and --mock never touch the API.

import { VerdictRejectedError } from "../src/shared/verdict.js";
import { costAndLatency, priceRangeHitRate, rejectionPrecision, scoreVariance } from "./metrics.js";

export const VARIANCE_LISTINGS = 5;
export const RUNS_PER_LISTING = 5;

/** Labels joined to the newest stored listing. The labels CSV has no asking price. */
export function loadEvalSet(db) {
  const labels = db.prepare("SELECT * FROM labels ORDER BY item_id").all();
  const newest = db.prepare(
    "SELECT title, price, condition, category, description FROM listings WHERE item_id = ? ORDER BY first_seen_at DESC LIMIT 1"
  );
  const ready = [];
  const missing = [];
  for (const label of labels) {
    const listing = newest.get(label.item_id);
    if (listing) ready.push({ label, listing: { ...listing, itemId: label.item_id } });
    else missing.push(label.item_id);
  }
  return { ready, missing };
}

/** The first few readable listings get repeated runs; the rest get one. */
export function planRuns(ready) {
  const readable = ready.filter((r) => r.label.readable).slice(0, VARIANCE_LISTINGS);
  return ready.map((r) => ({ ...r, runCount: readable.includes(r) ? RUNS_PER_LISTING : 1 }));
}

async function runOnce(evaluate, listing) {
  try {
    const verdict = await evaluate(listing);
    return { status: "valid", verdict, evaluation: verdict.evaluation };
  } catch (err) {
    const status = err instanceof VerdictRejectedError ? "rejected" : "error";
    return { status, reason: err.message, evaluation: err.evaluation };
  }
}

export async function runEval(planned, evaluate) {
  const results = [];
  for (const { label, listing, runCount } of planned) {
    const runs = [];
    for (let i = 0; i < runCount; i++) runs.push(await runOnce(evaluate, listing));
    results.push({ label, listing, runs });
  }
  return {
    results,
    metrics: {
      priceRangeHitRate: priceRangeHitRate(results),
      scoreVariance: scoreVariance(results, RUNS_PER_LISTING),
      rejectionPrecision: rejectionPrecision(results),
      costAndLatency: costAndLatency(results),
    },
  };
}
