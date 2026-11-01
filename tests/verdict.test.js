import test from "node:test";
import assert from "node:assert/strict";

import {
  VERDICT_JSON_SCHEMA,
  finalizeVerdict,
  readVerdict,
  toHistoryEntry,
  validateVerdict,
} from "../src/shared/verdict.js";

const verdict = (overrides = {}) => ({
  score: 60,
  verdict: "Fair",
  recommendation: "Negotiate",
  marketLow: 80,
  marketHigh: 120,
  suggestedOffer: 90,
  summary: "Fine.",
  ...overrides,
});

const textResponse = (text, stop_reason = "end_turn") => ({
  stop_reason,
  content: [{ type: "text", text }],
});

// --- validateVerdict ----------------------------------------------------------

test("accepts a valid verdict", () => {
  assert.equal(validateVerdict(verdict(), 100), null);
});

test("rejects missing required fields", () => {
  for (const field of VERDICT_JSON_SCHEMA.required) {
    const v = verdict();
    delete v[field];
    assert.notEqual(validateVerdict(v, 100), null, `missing ${field}`);
  }
});

test("rejects a score that isn't an integer from 0 to 100", () => {
  for (const score of [101, -1, 72.5, "60", null]) {
    assert.match(validateVerdict(verdict({ score }), 100), /invalid score/, `score ${score}`);
  }
});

test("rejects unknown verdicts and recommendations", () => {
  assert.match(validateVerdict(verdict({ verdict: "Steal" }), 100), /invalid verdict/);
  assert.match(validateVerdict(verdict({ recommendation: "Maybe" }), 100), /invalid recommendation/);
});

test("accepts enum values in any casing, since the API doesn't guarantee it", () => {
  assert.equal(validateVerdict(verdict({ verdict: "FAIR", recommendation: "negotiate" }), 100), null);
});

test("rejects an inverted market range", () => {
  assert.match(validateVerdict(verdict({ marketLow: 120, marketHigh: 80 }), 100), /inverted/);
});

test("rejects non-numeric or negative prices", () => {
  assert.match(validateVerdict(verdict({ marketLow: "80" }), 100), /invalid price/);
  assert.match(validateVerdict(verdict({ suggestedOffer: -5 }), 100), /invalid price/);
});

test("rejects an offer above both the asking price and the market", () => {
  assert.match(validateVerdict(verdict({ suggestedOffer: 500 }), 100), /unreasonably high/);
});

test("rejects an empty summary", () => {
  assert.match(validateVerdict(verdict({ summary: "  " }), 100), /no summary/);
});

test("rejects a verdict that contradicts its score, at each band edge", () => {
  const bands = [[85, "Great Deal"], [70, "Good Deal"], [50, "Fair"], [30, "Overpriced"], [0, "Avoid"]];
  for (const [score, label] of bands) {
    assert.equal(validateVerdict(verdict({ score, verdict: label }), 100), null, `score ${score}`);
    const wrong = label === "Fair" ? "Avoid" : "Fair";
    assert.match(validateVerdict(verdict({ score, verdict: wrong }), 100), /contradicts/);
  }
});

test("rejects a good score on an above-market price", () => {
  const v = verdict({ score: 90, verdict: "Great Deal", suggestedOffer: 100 });
  assert.match(validateVerdict(v, 500), /above-market/);
});

test("accepts a low score on an above-market price", () => {
  const v = verdict({ score: 40, verdict: "Overpriced", suggestedOffer: 100 });
  assert.equal(validateVerdict(v, 500), null);
});

test("accepts a free listing with an offer of 0", () => {
  const v = verdict({ score: 90, verdict: "Great Deal", suggestedOffer: 0 });
  assert.equal(validateVerdict(v, 0), null);
});

// --- readVerdict --------------------------------------------------------------

test("reads a valid JSON response", () => {
  const result = readVerdict(textResponse(JSON.stringify(verdict())), { price: 100 });
  assert.equal(result.ok, true);
  assert.equal(result.verdict.score, 60);
});

test("treats malformed JSON as retryable", () => {
  for (const text of ["not json", '{"score": 60,', ""]) {
    const result = readVerdict(textResponse(text), { price: 100 });
    assert.equal(result.ok, false);
    assert.equal(result.retryable, true);
    assert.match(result.reason, /valid JSON/);
  }
});

test("treats output cut off at max_tokens as retryable", () => {
  const result = readVerdict(textResponse('{"score": 60, "verd', "max_tokens"), { price: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
});

test("doesn't retry a refusal", () => {
  const result = readVerdict(textResponse("", "refusal"), { price: 100 });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, false);
  assert.match(result.reason, /declined/);
});

test("the schema is one the API accepts: no numeric ranges, closed object", () => {
  assert.equal(VERDICT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(Object.keys(VERDICT_JSON_SCHEMA.properties).sort(), [...VERDICT_JSON_SCHEMA.required].sort());
  assert.equal(/minimum|maximum/.test(JSON.stringify(VERDICT_JSON_SCHEMA)), false);
});

// --- finalizeVerdict ----------------------------------------------------------

test("takes the asking price from the scrape", () => {
  assert.equal(finalizeVerdict(verdict(), { price: 100 }).askingPrice, 100);
});

test("calculates savingsPercent in code", () => {
  assert.equal(finalizeVerdict(verdict(), { price: 50 }).savingsPercent, 50);
  assert.equal(finalizeVerdict(verdict(), { price: 150 }).savingsPercent, -50);
});

test("has no savingsPercent when the market midpoint is 0", () => {
  const v = verdict({ marketLow: 0, marketHigh: 0, suggestedOffer: 0 });
  assert.equal(finalizeVerdict(v, { price: 0 }).savingsPercent, null);
});

test("normalizes the casing of labels", () => {
  const v = finalizeVerdict(verdict({ verdict: "FAIR", recommendation: "negotiate" }), { price: 100 });
  assert.equal(v.verdict, "Fair");
  assert.equal(v.recommendation, "Negotiate");
});

test("caps the suggested offer at the asking price", () => {
  assert.equal(finalizeVerdict(verdict({ suggestedOffer: 110 }), { price: 100 }).suggestedOffer, 100);
});

test("handles a free listing without losing the 0 price", () => {
  const v = finalizeVerdict(verdict({ suggestedOffer: 10 }), { price: 0 });
  assert.equal(v.askingPrice, 0);
  assert.equal(v.suggestedOffer, 0);
  assert.equal(v.savingsPercent, 100);
});

test("doesn't change the verdict it was given", () => {
  const original = verdict({ suggestedOffer: 110 });
  finalizeVerdict(original, { price: 100 });
  assert.equal(original.suggestedOffer, 110);
});

// --- toHistoryEntry -----------------------------------------------------------

test("a history entry keeps the evaluation record", () => {
  const evaluation = { model: "claude-haiku-4-5", promptVersion: "3", inputTokens: 10, outputTokens: 5, latencyMs: 40, costUsd: 0.1 };
  const entry = toHistoryEntry({ url: "u", title: "t", price: 100, seller: "Fake Name" }, { ...verdict(), evaluation });
  assert.deepEqual(entry.evaluation, evaluation);
  assert.equal(entry.score, 60);
  assert.equal("seller" in entry, false);
});
