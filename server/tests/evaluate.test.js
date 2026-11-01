import { afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { Writable } from "node:stream";

import { revokeToken } from "../src/tokens.js";
import { GOOD_ANSWER, LISTING, apiReply, mockAnthropic, setup } from "./helpers.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const rows = (db) => db.prepare("SELECT * FROM evaluations ORDER BY id").all();

// --- Valid ---------------------------------------------------------------------

test("valid: returns a finalized verdict and records it", async () => {
  const { post, db } = setup();
  const calls = mockAnthropic(apiReply(GOOD_ANSWER));

  const res = await post({ listing: LISTING });

  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.status, "valid");
  assert.equal(body.verdict.askingPrice, 100);
  assert.equal(calls.length, 1);

  const [row] = rows(db);
  assert.equal(row.status, "valid");
  assert.equal(row.score, 60);
  assert.equal(row.price_low, 80);
  assert.equal(row.input_tokens, 1000);
  assert.ok(row.cost_usd > 0);
  assert.equal(row.item_id, LISTING.itemId);
});

test("valid: stores the minimal listing fields", async () => {
  const { post, db } = setup();
  mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  const listing = db.prepare("SELECT * FROM listings").get();
  assert.equal(listing.title, LISTING.title);
  assert.deepEqual(Object.keys(listing).sort(), [
    "category", "condition", "content_hash", "description", "first_seen_at", "item_id", "price", "title",
  ]);
});

test("uses the server's key, never one from the client, and defaults to Haiku", async () => {
  const { post } = setup();
  const calls = mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  assert.equal(calls[0].headers["x-api-key"], "sk-ant-fake-server-key");
  assert.equal(calls[0].body.model, "claude-haiku-4-5");
  assert.equal(calls[0].body.tools, undefined);
});

// --- Invalid output --------------------------------------------------------------

test("invalid output: retries once, rejects, and records the billed cost", async () => {
  const { post, db } = setup();
  const calls = mockAnthropic(apiReply("{not json"), apiReply("still not json"));

  const res = await post({ listing: LISTING });

  assert.equal(res.statusCode, 422);
  assert.equal(res.json().status, "rejected");
  assert.equal(res.json().code, "invalid_model_output");
  assert.equal(calls.length, 2);

  const [row] = rows(db);
  assert.equal(row.status, "rejected");
  assert.match(row.rejection_reason, /valid JSON/);
  assert.equal(row.attempts, 2);
  assert.equal(row.input_tokens, 2000);
  assert.ok(row.cost_usd > 0);
});

test("invalid output: rejects a contradictory answer", async () => {
  const { post } = setup();
  const bad = { ...GOOD_ANSWER, score: 95, verdict: "Overpriced" };
  mockAnthropic(apiReply(bad), apiReply(bad));
  const res = await post({ listing: LISTING });
  assert.equal(res.statusCode, 422);
  assert.match(res.json().reason, /contradicts/);
});

test("upstream failure: a typed error that leaks nothing, with the failure recorded", async () => {
  const { post, db } = setup();
  mockAnthropic({ httpStatus: 401 });
  const res = await post({ listing: LISTING });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().code, "upstream_error");
  assert.equal(JSON.stringify(res.json()).includes("sk-ant"), false);
  assert.equal(rows(db)[0].status, "error");
});

// --- Auth ------------------------------------------------------------------------

test("auth failure: no token, wrong token, and revoked token get 401 with no API call", async () => {
  const { post, db } = setup();
  const calls = mockAnthropic();

  for (const bad of [null, "dst_wrong"]) {
    const res = await post({ listing: LISTING }, bad);
    assert.equal(res.statusCode, 401, `token ${bad}`);
    assert.equal(res.json().code, "unauthorized");
  }

  const second = setup();
  revokeToken(second.db, 1);
  assert.equal((await second.post({ listing: LISTING })).statusCode, 401);

  assert.equal(calls.length, 0);
  assert.equal(rows(db).length, 0);
});

test("tokens are stored only as hashes", () => {
  const { db, token } = setup();
  const stored = db.prepare("SELECT token_hash FROM tokens").get().token_hash;
  assert.notEqual(stored, token);
  assert.equal(stored.includes(token), false);
});

test("each token is recorded on its evaluations", async () => {
  const { post, db } = setup();
  mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  assert.equal(rows(db)[0].token_id, 1);
});

// --- Budget ----------------------------------------------------------------------

test("budget cap: stops before calling the API once today's spend reaches it", async () => {
  const { post, db, config } = setup({ config: { dailyBudgetUsd: 0.0001 } });
  const calls = mockAnthropic(apiReply(GOOD_ANSWER));

  assert.equal((await post({ listing: LISTING })).statusCode, 200);
  assert.ok(rows(db)[0].cost_usd >= config.dailyBudgetUsd);

  const res = await post({ listing: { ...LISTING, price: 90 } });
  assert.equal(res.statusCode, 429);
  assert.equal(res.json().code, "budget_exceeded");
  assert.equal(calls.length, 1);
  assert.equal(rows(db)[1].rejection_reason, "budget_exceeded");
});

test("budget cap: rejected answers count toward it", async () => {
  const { post } = setup({ config: { dailyBudgetUsd: 0.0001 } });
  mockAnthropic(apiReply("{bad"), apiReply("{bad"));
  await post({ listing: LISTING });
  assert.equal((await post({ listing: LISTING })).json().code, "budget_exceeded");
});

test("budget cap: resets at the start of the next UTC day", async () => {
  let time = Date.UTC(2026, 0, 1, 23, 0);
  const { post } = setup({ config: { dailyBudgetUsd: 0.0001 }, app: { now: () => time } });
  mockAnthropic(apiReply(GOOD_ANSWER), apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });
  time = Date.UTC(2026, 0, 2, 0, 1);
  assert.equal((await post({ listing: LISTING })).statusCode, 200);
});

// --- No seller data ----------------------------------------------------------------

test("rejects a request carrying seller data, or any unknown field", async () => {
  const { post, db } = setup();
  const calls = mockAnthropic();
  for (const extra of [{ seller: "Fake Name" }, { sellerProfile: "/marketplace/profile/9/" }, { url: "x" }]) {
    const res = await post({ listing: { ...LISTING, ...extra } });
    assert.equal(res.statusCode, 400, JSON.stringify(extra));
  }
  assert.equal(calls.length, 0);
  assert.equal(db.prepare("SELECT COUNT(*) c FROM listings").get().c, 0);
});

test("no table has a column for seller data", () => {
  const { db } = setup();
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  for (const { name } of tables) {
    for (const column of db.pragma(`table_info(${name})`)) {
      assert.equal(/seller|profile/i.test(column.name), false, `${name}.${column.name}`);
    }
  }
});

test("rejects bad input: wrong types aren't coerced", async () => {
  const { post } = setup();
  mockAnthropic();
  for (const listing of [
    { ...LISTING, price: "100" },
    { ...LISTING, price: -1 },
    { ...LISTING, itemId: "12a" },
    { ...LISTING, title: "" },
  ]) {
    assert.equal((await post({ listing })).statusCode, 400, JSON.stringify(listing));
  }
  assert.equal((await post({ listing: LISTING, model: "claude-unpriced" })).statusCode, 400);
});

test("doesn't store photos", async () => {
  const { post, db } = setup();
  mockAnthropic(apiReply(GOOD_ANSWER));
  const data = "RkFLRVBIT1RPREFUQQ==";
  const res = await post({ listing: LISTING, images: [{ media_type: "image/jpeg", data }] });
  assert.equal(res.statusCode, 200);
  const dump = JSON.stringify([db.prepare("SELECT * FROM listings").all(), rows(db)]);
  assert.equal(dump.includes(data), false);
});

// --- Logs ------------------------------------------------------------------------

test("logs contain no token, key, or listing text", async () => {
  let logged = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      logged += chunk;
      cb();
    },
  });
  const { post, token } = setup({ app: { logger: { stream } } });
  mockAnthropic(apiReply(GOOD_ANSWER), { httpStatus: 401 });
  await post({ listing: LISTING });
  await post({ listing: LISTING });

  assert.ok(logged.length > 0);
  for (const secret of [token, "sk-ant-fake", LISTING.title, LISTING.description]) {
    assert.equal(logged.includes(secret), false, secret);
  }
});

// --- Other routes ------------------------------------------------------------------

test("GET /healthz needs no token", async () => {
  const { app } = setup();
  const res = await app.inject({ method: "GET", url: "/healthz" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { status: "ok" });
});

test("GET /v1/evaluations/:itemId returns the latest, and needs a token", async () => {
  const { app, post, token } = setup();
  mockAnthropic(apiReply(GOOD_ANSWER));
  await post({ listing: LISTING });

  const url = `/v1/evaluations/${LISTING.itemId}`;
  assert.equal((await app.inject({ method: "GET", url })).statusCode, 401);

  const headers = { authorization: `Bearer ${token}` };
  const res = await app.inject({ method: "GET", url, headers });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().score, 60);

  const missing = await app.inject({ method: "GET", url: "/v1/evaluations/999", headers });
  assert.equal(missing.statusCode, 404);
});
