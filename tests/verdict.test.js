// What is accepted from the model and what code computes itself: validation,
// retry decisions, the schema, and finalizeVerdict.

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

test("rejects a Buy score on a price more than 10% above the market high", () => {
  const v = verdict({ score: 90, suggestedOffer: 100 });
  assert.match(validateVerdict(v, 500), /above-market price as a Buy/);
});

test("accepts a low score on an above-market price", () => {
  const v = verdict({ score: 40, suggestedOffer: 100 });
  assert.equal(validateVerdict(v, 500), null);
});

test("accepts a Buy score on a price up to 10% above the market high: a judgment call", () => {
  // Market high 120: 132 is exactly 10% above, 133 is more.
  assert.equal(validateVerdict(verdict({ score: 90 }), 125), null);
  assert.equal(validateVerdict(verdict({ score: 90 }), 132), null);
  assert.match(validateVerdict(verdict({ score: 90 }), 133), /above-market/);
});

test("a borderline price with a good score passes: $1,300 against a $1,000–$1,200 range", () => {
  const v = verdict({ score: 75, marketLow: 1000, marketHigh: 1200, suggestedOffer: 1150 });
  assert.equal(validateVerdict(v, 1300), null);
});

test("on a clearly above-market price, only a Buy score is a contradiction", () => {
  // Written out by hand: 70 is the lowest Buy score.
  assert.equal(validateVerdict(verdict({ score: 69, suggestedOffer: 100 }), 500), null);
  assert.match(validateVerdict(verdict({ score: 70, suggestedOffer: 100 }), 500), /above-market/);
});

test("accepts a free listing with an offer of 0", () => {
  const v = verdict({ score: 90, suggestedOffer: 0 });
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

test("a contradiction is retryable, with feedback that names Claude's own numbers", () => {
  const answer = verdict({ score: 75, marketLow: 900, marketHigh: 1100, suggestedOffer: 1000 });
  const result = readVerdict(textResponse(JSON.stringify(answer)), { price: 1300, currency: "$" });
  assert.equal(result.ok, false);
  assert.equal(result.retryable, true);
  assert.match(result.reason, /above-market price as a Buy/);
  assert.deepEqual(result.feedback.answer, answer);
  assert.equal(
    result.feedback.message,
    "Your score of 75 is a Buy, but the asking price of $1,300 is more than 10% above your market range " +
      "of $900–$1,100. Reconcile them, and return the full JSON again."
  );
});

test("other invalid answers get no feedback, so the retry asks from scratch", () => {
  const malformed = readVerdict(textResponse("{not json"), { price: 100 });
  const badScore = readVerdict(textResponse(JSON.stringify(verdict({ score: 101 }))), { price: 100 });
  assert.equal(malformed.feedback, undefined);
  assert.equal(badScore.feedback, undefined);
});

test("the schema is one the API accepts: no numeric ranges, closed object", () => {
  assert.equal(VERDICT_JSON_SCHEMA.additionalProperties, false);
  assert.deepEqual(Object.keys(VERDICT_JSON_SCHEMA.properties).sort(), [...VERDICT_JSON_SCHEMA.required].sort());
  assert.equal(/minimum|maximum/.test(JSON.stringify(VERDICT_JSON_SCHEMA)), false);
});

test("the schema doesn't ask the model for anything code derives", () => {
  for (const field of ["verdict", "recommendation", "askingPrice", "savingsPercent"]) {
    assert.equal(field in VERDICT_JSON_SCHEMA.properties, false, field);
  }
});

test("ignores a verdict the model sends instead of rejecting it (live: 82 called a Great Deal)", () => {
  const sent = verdict({ score: 82, verdict: "Great Deal", recommendation: "Pass" });
  const result = readVerdict(textResponse(JSON.stringify(sent)), { price: 100 });
  assert.equal(result.ok, true);
  const v = finalizeVerdict(result.verdict, { price: 100 });
  assert.equal(v.verdict, "Good Deal");
  assert.equal(v.recommendation, "Buy");
});

test("ignores a verdict that isn't one of ours at all", () => {
  const result = readVerdict(textResponse(JSON.stringify(verdict({ verdict: "Steal" }))), { price: 100 });
  assert.equal(result.ok, true);
  assert.equal(finalizeVerdict(result.verdict, { price: 100 }).verdict, "Fair");
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

// Written out by hand rather than read from SCORE_BANDS, so a changed band
// edge fails here. Every edge, one either side, and both ends of the range.
const EXPECTED_BY_SCORE = [
  [100, "Great Deal", "Buy"],
  [86, "Great Deal", "Buy"],
  [85, "Great Deal", "Buy"],
  [84, "Good Deal", "Buy"],
  [71, "Good Deal", "Buy"],
  [70, "Good Deal", "Buy"],
  [69, "Fair", "Negotiate"],
  [51, "Fair", "Negotiate"],
  [50, "Fair", "Negotiate"],
  [49, "Overpriced", "Negotiate"],
  [31, "Overpriced", "Negotiate"],
  [30, "Overpriced", "Negotiate"],
  [29, "Avoid", "Pass"],
  [1, "Avoid", "Pass"],
  [0, "Avoid", "Pass"],
];

test("derives the verdict and recommendation from the score, at and around every band edge", () => {
  for (const [score, label, recommendation] of EXPECTED_BY_SCORE) {
    const v = finalizeVerdict(verdict({ score }), { price: 100 });
    assert.equal(v.verdict, label, `score ${score}`);
    assert.equal(v.recommendation, recommendation, `score ${score}`);
  }
});

test("keeps only the fields it names", () => {
  const v = finalizeVerdict(verdict({ score: 82, verdict: "Great Deal", extra: "x" }), { price: 100 });
  assert.equal(v.verdict, "Good Deal");
  assert.equal("extra" in v, false);
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
