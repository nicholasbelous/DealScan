// The server's cache, per-token rate limit, and stats. Anthropic is mocked.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { createToken } from "../src/tokens.js";
import { GOOD_ANSWER, LISTING, apiReply, mockAnthropic, setup } from "./helpers.js";
import { buildStats } from "../src/stats.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const rows = (db) => db.prepare("SELECT * FROM evaluations ORDER BY id").all();

// --- Cache ---------------------------------------------------------------------

test("cache: identical content is answered without another API call", async () => {
  const { post, db } = setup();
  const calls = mockAnthropic(apiReply(GOOD_ANSWER));

  await post({ listing: LISTING });
  const res = await post({ listing: LISTING });

  assert.equal(res.statusCode, 200);
  const { verdict } = res.json();
  assert.equal(verdict.fromCache, true);
  assert.equal(verdict.score, 60);
  assert.equal(verdict.evaluation.costUsd, 0);
  assert.equal(calls.length, 1);

  const [first, second] = rows(db);
  assert.equal(first.cache_hit, 0);
  assert.equal(second.cache_hit, 1);
  assert.equal(second.cost_usd, 0);
});

test("cache: shared across tokens", async () => {
  const { post, db } = setup();
  const calls = mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  const other = createToken(db, "someone-else");
  assert.equal((await post({ listing: LISTING }, other)).json().verdict.fromCache, true);
  assert.equal(calls.length, 1);
});

for (const [name, change] of [
  ["price", { listing: { ...LISTING, price: 90 } }],
  ["description", { listing: { ...LISTING, description: "Changed." } }],
  ["item ID", { listing: { ...LISTING, itemId: "1110002" } }],
  ["model", { listing: LISTING, model: "claude-sonnet-4-6" }],
  ["photos", { listing: LISTING, images: [{ media_type: "image/jpeg", data: "RkFLRQ==" }] }],
]) {
  test(`cache: a changed ${name} is a miss`, async () => {
    const { post } = setup();
    const calls = mockAnthropic(apiReply(GOOD_ANSWER), apiReply(GOOD_ANSWER));
    await post({ listing: LISTING });
    const res = await post(change);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().verdict.fromCache, undefined);
    assert.equal(calls.length, 2);
  });
}

test("cache: a different prompt version is a miss", async () => {
  const { post, db } = setup();
  const calls = mockAnthropic(apiReply(GOOD_ANSWER), apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  db.prepare("UPDATE evaluations SET prompt_version = 'older'").run();
  await post({ listing: LISTING });
  assert.equal(calls.length, 2);
});

test("cache: entries expire, and hits don't extend them", async () => {
  let time = 1_000_000;
  const { post } = setup({ config: { cacheTtlMs: 1000 }, app: { now: () => time } });
  const calls = mockAnthropic(apiReply(GOOD_ANSWER), apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  time += 900;
  await post({ listing: LISTING });
  assert.equal(calls.length, 1);
  time += 200; // past the original's TTL, though the last hit was recent
  await post({ listing: LISTING });
  assert.equal(calls.length, 2);
});

test("cache: rejected answers aren't cached", async () => {
  const { post } = setup();
  const calls = mockAnthropic(apiReply("{bad"), apiReply("{bad"), apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  const res = await post({ listing: LISTING });
  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 3);
});

test("cache: hits still work over budget, since they cost nothing", async () => {
  const { post } = setup({ config: { dailyBudgetUsd: 0.0001 } });
  mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  const res = await post({ listing: LISTING });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().verdict.fromCache, true);
});

// --- Rate limit ------------------------------------------------------------------

test("rate limit: applies per token, with a typed error and no API call", async () => {
  const { post, db } = setup({ config: { rateLimitPerMinute: 1 } });
  const calls = mockAnthropic(apiReply(GOOD_ANSWER), apiReply(GOOD_ANSWER));

  assert.equal((await post({ listing: LISTING })).statusCode, 200);
  const limited = await post({ listing: LISTING });
  assert.equal(limited.statusCode, 429);
  assert.equal(limited.json().code, "rate_limited");
  assert.equal(calls.length, 1);

  const other = createToken(db, "someone-else");
  assert.equal((await post({ listing: LISTING }, other)).statusCode, 200);
});

test("rate limit: a bad token gets 401, not a rate limit slot", async () => {
  const { post } = setup({ config: { rateLimitPerMinute: 1 } });
  mockAnthropic();
  for (let i = 0; i < 3; i++) {
    assert.equal((await post({ listing: LISTING }, "dst_wrong")).statusCode, 401);
  }
});

// --- Stats -----------------------------------------------------------------------

test("stats: aggregates by hand-checkable numbers", () => {
  const row = (o) => ({ status: "valid", rejection_reason: null, cost_usd: 1, latency_ms: 100, attempts: 1, cache_hit: 0, ...o });
  const stats = buildStats([
    row({ cost_usd: 1, latency_ms: 100 }),
    row({ cost_usd: 2, latency_ms: 200 }),
    row({ status: "rejected", rejection_reason: "bad", cost_usd: 4, latency_ms: 400, attempts: 2 }),
    row({ status: "rejected", rejection_reason: "bad", cost_usd: 8, latency_ms: 800, attempts: 2 }),
    row({ status: "error", rejection_reason: "budget_exceeded", cost_usd: null, latency_ms: null, attempts: 0 }),
    row({ cost_usd: 0, latency_ms: 0, attempts: 0, cache_hit: 1 }),
  ]);
  assert.deepEqual(stats.byStatus, { valid: 3, rejected: 2, error: 1 });
  assert.equal(stats.total, 6);
  assert.deepEqual(stats.topRejectionReasons, [
    { reason: "bad", count: 2 },
    { reason: "budget_exceeded", count: 1 },
  ]);
  // Billed rows only: cache hits and budget refusals can't flatter these.
  assert.deepEqual(stats.costUsd, { median: 2, p90: 8 });
  assert.equal(stats.totalCostUsd, 15);
  assert.deepEqual(stats.latencyMs, { median: 200, p90: 800 });
  assert.equal(stats.cacheHitRate, 1 / 3);
});

test("stats: empty is honest, not zero", () => {
  const stats = buildStats([]);
  assert.equal(stats.total, 0);
  assert.equal(stats.costUsd.median, null);
  assert.equal(stats.cacheHitRate, null);
});

test("GET /v1/stats: needs a token, reports real rows, and honors the window", async () => {
  let time = Date.UTC(2026, 0, 10);
  const { app, post, token } = setup({ app: { now: () => time } });
  mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  await post({ listing: LISTING });

  assert.equal((await app.inject({ method: "GET", url: "/v1/stats" })).statusCode, 401);

  const get = (query) =>
    app.inject({ method: "GET", url: `/v1/stats${query}`, headers: { authorization: `Bearer ${token}` } });
  const stats = (await get("?window=24h")).json();
  assert.equal(stats.total, 2);
  assert.equal(stats.byStatus.valid, 2);
  assert.equal(stats.cacheHitRate, 0.5);
  assert.ok(stats.costUsd.median > 0);

  time += 2 * 86_400_000;
  assert.equal((await get("?window=24h")).json().total, 0);
  assert.equal((await get("?window=7d")).json().total, 2);
  assert.equal((await get("?window=bogus")).statusCode, 400);
});

test("GET /stats: the page holds no data, and locks down what it can load", async () => {
  const { app, post } = setup();
  mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });

  const page = await app.inject({ method: "GET", url: "/stats" });
  assert.equal(page.statusCode, 200);
  assert.match(page.headers["content-type"], /text\/html/);
  assert.match(page.headers["content-security-policy"], /default-src 'none'/);
  assert.equal(page.body.includes(LISTING.title), false);
  assert.equal(/\b0\.\d{3,}/.test(page.body), false);
});
