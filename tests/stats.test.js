import test from "node:test";
import assert from "node:assert/strict";

import { median, p90, percentile, summarizeCost } from "../src/shared/stats.js";

test("nearest-rank percentiles", () => {
  const values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
  assert.equal(median(values), 50);
  assert.equal(p90(values), 90);
  assert.equal(percentile(values, 100), 100);
  assert.equal(median([5]), 5);
});

test("ignores order and non-numbers", () => {
  assert.equal(median([3, null, 1, undefined, 2]), 2);
});

test("is null with no values", () => {
  assert.equal(median([]), null);
});

test("summarizes cost and skips unknown costs", () => {
  assert.deepEqual(summarizeCost([{ costUsd: 1 }, { costUsd: 3 }, { costUsd: null }]), {
    count: 2,
    median: 1,
    p90: 3,
    total: 4,
  });
  assert.equal(summarizeCost([{ costUsd: null }]), null);
  assert.equal(summarizeCost([]), null);
});
