// Server mode with fetch mocked. Never calls a real server.

import { afterEach, test } from "node:test";
import assert from "node:assert/strict";

import { contentHash } from "../src/shared/cache-key.js";
import { evaluateViaServer } from "../src/shared/server-client.js";
import { VerdictRejectedError } from "../src/shared/verdict.js";

const settings = { serverUrl: "https://server.example/", serverToken: "dst_fake", model: "claude-haiku-4-5" };
const listing = {
  itemId: "1110001",
  url: "https://www.facebook.com/marketplace/item/1110001/",
  reliable: true,
  title: "Fake Bike",
  price: 100,
  priceRaw: "$100",
  currency: "$",
  condition: null,
  category: "sports",
  description: "A bike.",
  location: null,
  attributes: null,
  images: ["https://cdn.example/a.jpg"],
};

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockServer(status, body) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    return { ok: status < 400, status, json: async () => body };
  };
  return calls;
}

test("sends only the allowed fields, with the token in a header", async () => {
  const calls = mockServer(200, { status: "valid", verdict: { score: 60 } });
  const verdict = await evaluateViaServer(settings, listing);
  assert.equal(verdict.score, 60);
  assert.equal(calls[0].url, "https://server.example/v1/evaluate");
  assert.equal(calls[0].init.headers.authorization, "Bearer dst_fake");
  assert.equal(calls[0].body.listing.itemId, "1110001");
  for (const field of ["url", "images", "reliable", "seller"]) {
    assert.equal(field in calls[0].body.listing, false, field);
  }
});

test("a server rejection becomes a rejection, with its billed usage", async () => {
  mockServer(422, { status: "rejected", reason: "Claude's answer was bad.", evaluation: { inputTokens: 5 } });
  await assert.rejects(evaluateViaServer(settings, listing), (err) => {
    assert.ok(err instanceof VerdictRejectedError);
    assert.equal(err.evaluation.inputTokens, 5);
    return true;
  });
});

test("typed errors become readable messages", async () => {
  mockServer(401, { code: "unauthorized" });
  await assert.rejects(evaluateViaServer(settings, listing), /refused this token/);
  mockServer(429, { code: "budget_exceeded", reason: "The server's daily budget has been reached." });
  await assert.rejects(evaluateViaServer(settings, listing), /daily budget/);
});

test("needs a URL and token", async () => {
  await assert.rejects(evaluateViaServer({ serverUrl: "", serverToken: "" }, listing), /URL and token/);
});

test("reports an unreachable server", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("network");
  };
  await assert.rejects(evaluateViaServer(settings, listing), /Couldn't reach/);
});

test("the content hash ignores formatting but sees real changes", async () => {
  const a = await contentHash(listing);
  assert.equal(await contentHash({ ...listing, title: "  fake   BIKE " }), a);
  assert.notEqual(await contentHash({ ...listing, price: 99 }), a);
  assert.notEqual(await contentHash({ ...listing, description: "Other." }), a);
  assert.notEqual(await contentHash(listing, [{ data: "photo" }]), a);
});
