import test from "node:test";
import assert from "node:assert/strict";

import { formatCost, marketPosition, noPhotosNotice } from "../src/shared/formatter.js";

test("no notice when photos were analyzed", () => {
  const verdict = { imagesAnalyzed: 2, photoAnalysisOn: true };
  assert.equal(noPhotosNotice(verdict, "panel_product_id"), null);
});

test("a panel read without photos says to reload", () => {
  const verdict = { imagesAnalyzed: 0, photoAnalysisOn: true };
  assert.equal(
    noPhotosNotice(verdict, "panel_product_id"),
    "Evaluated without photos: reload to include them."
  );
});

test("doesn't suggest reloading when that wouldn't help", () => {
  const off = noPhotosNotice({ imagesAnalyzed: 0, photoAnalysisOn: false }, "panel_product_id");
  assert.match(off, /off in Options/);
  const noneFound = noPhotosNotice({ imagesAnalyzed: 0, imagesOffered: 0, photoAnalysisOn: true }, "embedded_data");
  assert.doesNotMatch(noneFound, /reload/);
});

test("a page-data read says whether photos were missing or failed to download", () => {
  const notice = (imagesOffered) =>
    noPhotosNotice({ imagesAnalyzed: 0, imagesOffered, photoAnalysisOn: true }, "embedded_data");
  assert.equal(notice(0), "Evaluated without photos: none were found in this page's listing data.");
  assert.equal(notice(1), "Evaluated without photos: 1 photo was found, but none could be downloaded.");
  assert.equal(notice(3), "Evaluated without photos: 3 photos were found, but none could be downloaded.");
  assert.equal(notice(undefined), "Evaluated without photos.");
});

test("an asking price inside the market range shows no percentage (live: $1,500 in $1,200-$1,600)", () => {
  const range = { marketLow: 1200, marketHigh: 1600, savingsPercent: -7 };
  for (const askingPrice of [1200, 1500, 1600]) {
    assert.deepEqual(marketPosition({ ...range, askingPrice }), { text: "Within market range", tone: "within" });
  }
});

test("a percentage shows only outside the market range", () => {
  const range = { marketLow: 1200, marketHigh: 1600 };
  assert.deepEqual(marketPosition({ ...range, askingPrice: 1000, savingsPercent: 29 }), { text: "29% below", tone: "below" });
  assert.deepEqual(marketPosition({ ...range, askingPrice: 1700, savingsPercent: -21 }), { text: "21% above", tone: "above" });
  assert.deepEqual(marketPosition({ ...range, askingPrice: 0, savingsPercent: 100 }), { text: "100% below", tone: "below" });
});

test("no market position without a usable range", () => {
  assert.equal(marketPosition({ askingPrice: 100, marketLow: 0, marketHigh: 0, savingsPercent: null }), null);
  assert.equal(marketPosition({ askingPrice: 100, marketLow: null, marketHigh: 120, savingsPercent: 10 }), null);
});

test("formats cost to four decimals, with a dash when unknown", () => {
  assert.equal(formatCost(0.0015), "$0.0015");
  assert.equal(formatCost(null), "—");
});
