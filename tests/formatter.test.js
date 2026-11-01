import test from "node:test";
import assert from "node:assert/strict";

import { formatCost, noPhotosNotice } from "../src/shared/formatter.js";

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
  const noneLoaded = noPhotosNotice({ imagesAnalyzed: 0, photoAnalysisOn: true }, "embedded_data");
  assert.match(noneLoaded, /none could be loaded/);
});

test("formats cost to four decimals, with a dash when unknown", () => {
  assert.equal(formatCost(0.0015), "$0.0015");
  assert.equal(formatCost(null), "—");
});
