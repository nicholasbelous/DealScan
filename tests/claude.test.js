import test from "node:test";
import assert from "node:assert/strict";

import { finalizeVerdict } from "../src/shared/claude.js";

const verdict = (overrides = {}) => ({
  score: 60,
  verdict: "Fair",
  recommendation: "Negotiate",
  askingPrice: 100,
  marketLow: 80,
  marketHigh: 120,
  suggestedOffer: 90,
  savingsPercent: 0,
  summary: "Fine.",
  ...overrides,
});

test("takes the asking price from the scrape, not the model", () => {
  const v = finalizeVerdict(verdict({ askingPrice: 999 }), { price: 100 });
  assert.equal(v.askingPrice, 100);
});

test("calculates savingsPercent in code, ignoring the model's value", () => {
  const below = finalizeVerdict(verdict({ savingsPercent: -50 }), { price: 50 });
  assert.equal(below.savingsPercent, 50);

  const above = finalizeVerdict(verdict({ savingsPercent: 50, suggestedOffer: 100 }), { price: 150 });
  assert.equal(above.savingsPercent, -50);
});

test("sets the verdict label from the score at each band edge", () => {
  const cases = [
    [100, "Great Deal"],
    [85, "Great Deal"],
    [84, "Good Deal"],
    [70, "Good Deal"],
    [69, "Fair"],
    [50, "Fair"],
    [49, "Overpriced"],
    [30, "Overpriced"],
    [29, "Avoid"],
    [0, "Avoid"],
  ];
  for (const [score, label] of cases) {
    const v = finalizeVerdict(verdict({ score, verdict: "Great Deal" }), { price: 100 });
    assert.equal(v.verdict, label, `score ${score}`);
  }
});

test("clamps and rounds the score", () => {
  assert.equal(finalizeVerdict(verdict({ score: 150 }), { price: 100 }).score, 100);
  assert.equal(finalizeVerdict(verdict({ score: -5 }), { price: 100 }).score, 0);
  assert.equal(finalizeVerdict(verdict({ score: 72.6 }), { price: 100 }).score, 73);
});

test("leaves a non-numeric score null and keeps the model's label", () => {
  const v = finalizeVerdict(verdict({ score: "high", verdict: "Fair" }), { price: 100 });
  assert.equal(v.score, null);
  assert.equal(v.verdict, "Fair");
});

test("corrects an inverted market range", () => {
  const v = finalizeVerdict(verdict({ marketLow: 120, marketHigh: 80 }), { price: 100 });
  assert.equal(v.marketLow, 80);
  assert.equal(v.marketHigh, 120);
});

test("caps the suggested offer at the asking price", () => {
  const v = finalizeVerdict(verdict({ suggestedOffer: 500 }), { price: 100 });
  assert.equal(v.suggestedOffer, 100);
});

test("coerces numeric strings and blanks out junk", () => {
  const v = finalizeVerdict(
    verdict({ marketLow: "80", marketHigh: "120", suggestedOffer: "lots" }),
    { price: 100 }
  );
  assert.equal(v.marketLow, 80);
  assert.equal(v.marketHigh, 120);
  assert.equal(v.suggestedOffer, null);
});

test("handles a free listing without losing the 0 price", () => {
  const v = finalizeVerdict(
    verdict({ askingPrice: 50, suggestedOffer: 10 }),
    { price: 0 }
  );
  assert.equal(v.askingPrice, 0);
  assert.equal(v.suggestedOffer, 0);
  assert.equal(v.savingsPercent, 100);
});

test("falls back to the model's savingsPercent without a market range", () => {
  const v = finalizeVerdict(
    verdict({ marketLow: null, marketHigh: null, savingsPercent: 12 }),
    { price: 100 }
  );
  assert.equal(v.savingsPercent, 12);
});
