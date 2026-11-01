// What we accept from the model, and what we refuse to take its word for.
//
// readVerdict() decides whether a response can be used at all: the structure is
// checked here in code, and an answer that contradicts itself is invalid.
// finalizeVerdict() then replaces every value we can compute ourselves. Pure
// logic, no chrome.* calls.

const VERDICT_BANDS = [
  [85, "Great Deal"],
  [70, "Good Deal"],
  [50, "Fair"],
  [30, "Overpriced"],
  [0, "Avoid"],
];
const VERDICTS = VERDICT_BANDS.map(([, label]) => label);
const RECOMMENDATIONS = ["Buy", "Negotiate", "Pass"];

// Sent as output_config.format. The API doesn't accept numeric ranges in a
// schema, so validateVerdict() checks those.
export const VERDICT_JSON_SCHEMA = {
  type: "object",
  properties: {
    score: { type: "integer" },
    verdict: { type: "string", enum: VERDICTS },
    recommendation: { type: "string", enum: RECOMMENDATIONS },
    marketLow: { type: "number" },
    marketHigh: { type: "number" },
    suggestedOffer: { type: "number" },
    summary: { type: "string" },
  },
  required: ["score", "verdict", "recommendation", "marketLow", "marketHigh", "suggestedOffer", "summary"],
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
 * @returns {{ok: true, verdict: object} | {ok: false, retryable: boolean, reason: string}}
 */
export function readVerdict(response, listing) {
  if (response.stop_reason === "refusal") {
    return { ok: false, retryable: false, reason: "Claude declined to evaluate this listing." };
  }

  const parsed = parseJsonFromText(response);
  const reason = parsed ? validateVerdict(parsed, listing.price) : "the response wasn't valid JSON";
  return reason ? { ok: false, retryable: true, reason: `Claude's answer ${reason}.` } : { ok: true, verdict: parsed };
}

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
  if (!matchesCase(VERDICTS, v.verdict)) return "had an invalid verdict";
  if (!matchesCase(RECOMMENDATIONS, v.recommendation)) return "had an invalid recommendation";
  if (typeof v.summary !== "string" || !v.summary.trim()) return "had no summary";

  const prices = [v.marketLow, v.marketHigh, v.suggestedOffer];
  if (!prices.every((p) => Number.isFinite(p) && p >= 0)) return "had an invalid price";
  if (v.marketLow > v.marketHigh) return "had an inverted market range";
  if (v.suggestedOffer > Math.max(askingPrice, v.marketHigh)) return "suggested an unreasonably high offer";

  if (!sameText(v.verdict, verdictForScore(v.score))) return "gave a verdict that contradicts its score";
  if (askingPrice > v.marketHigh && v.score >= 50) return "rated an above-market price as a good deal";
  return null;
}

/**
 * Replace everything we can compute ourselves. Takes a verdict that passed
 * validateVerdict. Never trust model arithmetic or labels:
 *   - asking price comes from the scrape
 *   - savingsPercent is asking vs market midpoint: positive means below market
 *   - the verdict label comes from the score
 *   - the offer never exceeds the asking price
 */
export function finalizeVerdict(v, listing) {
  const midpoint = (v.marketLow + v.marketHigh) / 2;
  return {
    ...v,
    verdict: verdictForScore(v.score),
    recommendation: RECOMMENDATIONS.find((r) => sameText(r, v.recommendation)),
    askingPrice: listing.price,
    savingsPercent: midpoint > 0 ? Math.round(((midpoint - listing.price) / midpoint) * 100) : null,
    suggestedOffer: Math.min(v.suggestedOffer, listing.price),
  };
}

function verdictForScore(score) {
  return VERDICT_BANDS.find(([min]) => score >= min)[1];
}

// The API doesn't guarantee the casing of enum values.
const sameText = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
const matchesCase = (allowed, value) => allowed.some((option) => sameText(option, value));
