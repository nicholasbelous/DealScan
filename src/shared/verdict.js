// What we accept from the model, and what we refuse to take its word for.
//
// readVerdict() decides whether a response can be used at all: the structure is
// checked here in code, and an answer that contradicts itself is invalid.
// finalizeVerdict() then replaces every value we can compute ourselves. Pure
// logic, no chrome.* calls.

import { formatMoney } from "./formatter.js";

// The only definition of the score bands. Code derives the verdict and the
// recommendation from the score, and the prompt's scoring guide is built from
// this table, so the model is never asked for a label code can compute.
export const SCORE_BANDS = [
  { min: 85, verdict: "Great Deal", recommendation: "Buy" },
  { min: 70, verdict: "Good Deal", recommendation: "Buy" },
  { min: 50, verdict: "Fair", recommendation: "Negotiate" },
  { min: 30, verdict: "Overpriced", recommendation: "Negotiate" },
  { min: 0, verdict: "Avoid", recommendation: "Pass" },
];

export const MIN_BUY_SCORE = Math.min(
  ...SCORE_BANDS.filter((band) => band.recommendation === "Buy").map((band) => band.min)
);

// A Buy is a contradiction only when the asking price is more than this far
// above Claude's own market high. Closer than that, it's a judgment call. The
// prompt states the same rule from these constants.
export const OVERPRICE_TOLERANCE = 0.1;

const CONTRADICTION = "rated a clearly above-market price as a Buy";

// Sent as output_config.format. The API doesn't accept numeric ranges in a
// schema, so validateVerdict() checks those.
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    marketLow: { type: "number" },
    marketHigh: { type: "number" },
    suggestedOffer: { type: "number" },
    summary: { type: "string" },
  },
  required: ["score", "marketLow", "marketHigh", "suggestedOffer", "summary"],
  additionalProperties: false,
};

/** The model's answer failed validation, or it declined. Not a network or API failure. */
export class VerdictRejectedError extends Error {
  constructor(reason) {
    super(reason);
    this.name = "VerdictRejectedError";
  }
}

/**
 * Read a verdict out of a Messages API response.
 * @returns {{ok: true, verdict: object}
 *   | {ok: false, retryable: boolean, reason: string, feedback?: {answer: object, message: string}}}
 *   feedback is set only for a contradiction: the answer, and what to tell
 *   Claude about it on the retry.
 */
export function readVerdict(response, listing) {
  if (response.stop_reason === "refusal") {
    return { ok: false, retryable: false, reason: "Claude declined to evaluate this listing." };
  }

  const parsed = parseJsonFromText(response);
  const problem = parsed ? validateVerdict(parsed, listing.price) : "the response wasn't valid JSON";
  if (!problem) return { ok: true, verdict: parsed };

  const result = { ok: false, retryable: true, reason: `Claude's answer ${problem}.` };
  if (problem === CONTRADICTION) {
    result.feedback = { answer: parsed, message: contradictionFeedback(parsed, listing) };
  }
  return result;
}

// Web search mode sends no JSON schema, so the answer can arrive with text
// around it. Take the outermost {...} and let validation judge the rest.
function parseJsonFromText(response) {
  const text = (response.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) return null;
  try {
    return JSON.parse(json[0]);
  } catch {
    return null;
  }
}

/** @returns {string|null} what's wrong with the verdict, or null if it's valid. */
export function validateVerdict(v, askingPrice) {
  if (!Number.isInteger(v.score) || v.score < 0 || v.score > 100) return "had an invalid score";
  if (typeof v.summary !== "string" || !v.summary.trim()) return "had no summary";

  const prices = [v.marketLow, v.marketHigh, v.suggestedOffer];
  if (!prices.every((p) => Number.isFinite(p) && p >= 0)) return "had an invalid price";
  if (v.marketLow > v.marketHigh) return "had an inverted market range";
  if (v.suggestedOffer > Math.max(askingPrice, v.marketHigh)) return "suggested an unreasonably high offer";

  const clearlyAboveMarket = askingPrice > v.marketHigh * (1 + OVERPRICE_TOLERANCE);
  if (clearlyAboveMarket && v.score >= MIN_BUY_SCORE) return CONTRADICTION;
  return null;
}

// Claude's own numbers, so the retry can fix the one thing that contradicted.
function contradictionFeedback(v, listing) {
  const money = (amount) => formatMoney(amount, listing.currency ?? "$");
  const percent = Math.round(OVERPRICE_TOLERANCE * 100);
  return (
    `Your score of ${v.score} is a Buy, but the asking price of ${money(listing.price)} is more than ` +
    `${percent}% above your market range of ${money(v.marketLow)}–${money(v.marketHigh)}. ` +
    "Reconcile them, and return the full JSON again."
  );
}

/**
 * Replace everything we can compute ourselves. Takes a verdict that passed
 * validateVerdict. Never trust model arithmetic or labels:
 *   - asking price comes from the scrape
 *   - savingsPercent is asking vs market midpoint: positive means below market
 *   - the verdict and recommendation come from the score
 *   - the offer never exceeds the asking price
 * Only the fields named here are kept, so anything else the model sends, such
 * as its own verdict, is ignored.
 */
export function finalizeVerdict(v, listing) {
  const midpoint = (v.marketLow + v.marketHigh) / 2;
  const band = bandForScore(v.score);
  return {
    score: v.score,
    verdict: band.verdict,
    recommendation: band.recommendation,
    marketLow: v.marketLow,
    marketHigh: v.marketHigh,
    suggestedOffer: Math.min(v.suggestedOffer, listing.price),
    summary: v.summary,
    askingPrice: listing.price,
    savingsPercent: midpoint > 0 ? Math.round(((midpoint - listing.price) / midpoint) * 100) : null,
  };
}

/** What Save keeps: the result, plus the evaluation record for measuring cost. */
export function toHistoryEntry(listing, verdict) {
  return {
    url: listing.url,
    title: listing.title,
    category: listing.category,
    price: listing.price,
    currency: listing.currency,
    score: verdict.score,
    verdict: verdict.verdict,
    recommendation: verdict.recommendation,
    suggestedOffer: verdict.suggestedOffer,
    summary: verdict.summary,
    evaluation: verdict.evaluation,
  };
}

function bandForScore(score) {
  return SCORE_BANDS.find((band) => score >= band.min);
}
