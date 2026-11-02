// The cost of an evaluation from API usage and the pricing table.

import test from "node:test";
import assert from "node:assert/strict";

import { addUsage, costUsd, emptyUsage, MODEL_PRICES, WEB_SEARCH_USD } from "../src/shared/pricing.js";

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-12, `${actual} vs ${expected}`);

test("every model offered in Options has a price", async () => {
  const fs = await import("node:fs");
  const html = fs.readFileSync(new URL("../src/options/options.html", import.meta.url), "utf8");
  const models = [...html.matchAll(/<option value="(claude-[^"]+)"/g)].map((m) => m[1]);
  assert.ok(models.length > 0);
  for (const model of models) assert.ok(MODEL_PRICES[model], model);
});

test("sums usage across API calls, including server tool use", () => {
  let total = emptyUsage();
  total = addUsage(total, { input_tokens: 100, output_tokens: 20 });
  total = addUsage(total, {
    input_tokens: 50,
    output_tokens: 10,
    cache_creation_input_tokens: 7,
    cache_read_input_tokens: 3,
    server_tool_use: { web_search_requests: 1 },
  });
  assert.deepEqual(total, {
    inputTokens: 150,
    outputTokens: 30,
    cacheWriteTokens: 7,
    cacheReadTokens: 3,
    webSearches: 1,
  });
});

test("tolerates a missing usage object", () => {
  assert.deepEqual(addUsage(emptyUsage(), undefined), emptyUsage());
});

test("prices each token type at its own rate", () => {
  const usage = { ...emptyUsage(), inputTokens: 1_000_000 };
  near(costUsd("claude-haiku-4-5", usage), MODEL_PRICES["claude-haiku-4-5"].input);
  near(costUsd("claude-haiku-4-5", { ...emptyUsage(), outputTokens: 1_000_000 }), MODEL_PRICES["claude-haiku-4-5"].output);
  near(costUsd("claude-sonnet-4-6", { ...emptyUsage(), cacheWriteTokens: 1_000_000 }), MODEL_PRICES["claude-sonnet-4-6"].cacheWrite);
  near(costUsd("claude-opus-4-8", { ...emptyUsage(), cacheReadTokens: 1_000_000 }), MODEL_PRICES["claude-opus-4-8"].cacheRead);
});

test("adds the per-search fee", () => {
  near(costUsd("claude-haiku-4-5", { ...emptyUsage(), webSearches: 2 }), 2 * WEB_SEARCH_USD);
});

test("returns null, not a guess, for an unknown model", () => {
  assert.equal(costUsd("claude-unknown", emptyUsage()), null);
});
