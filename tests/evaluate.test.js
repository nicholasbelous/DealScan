// evaluateListing end to end with fetch mocked. Never calls the real API.

import { afterEach, beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { evaluateListing } from "../src/shared/claude.js";
import { VerdictRejectedError } from "../src/shared/verdict.js";

const listing = {
  title: "Fake Road Bike",
  price: 100,
  priceRaw: "$100",
  description: "A made-up bike.",
  category: "sports",
};

const good = {
  score: 60,
  verdict: "Fair",
  recommendation: "Negotiate",
  marketLow: 80,
  marketHigh: 120,
  suggestedOffer: 90,
  summary: "Fine.",
};

const reply = (body, stop_reason = "end_turn") => ({
  stop_reason,
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
  usage: { input_tokens: 10, output_tokens: 5 },
});

let requests;
const realFetch = globalThis.fetch;

function mockApi(...replies) {
  globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    const next = replies.shift();
    assert.ok(next, "made more API calls than expected");
    return { ok: true, json: async () => next };
  };
}

function useSettings(settings = {}) {
  globalThis.chrome = {
    storage: {
      local: { get: (key, cb) => cb({ [key]: { anthropicKey: "sk-ant-fake", ...settings } }) },
    },
  };
}

beforeEach(() => {
  requests = [];
  useSettings();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.chrome;
});

test("returns a finalized verdict from a valid answer in one call", async () => {
  mockApi(reply(good));
  const v = await evaluateListing(listing);
  assert.equal(requests.length, 1);
  assert.equal(v.askingPrice, 100);
  assert.equal(v.savingsPercent, 0);
});

test("requests the JSON schema by default, with the cheap defaults", async () => {
  mockApi(reply(good));
  await evaluateListing(listing);
  const [body] = requests;
  assert.equal(body.model, "claude-haiku-4-5");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.tools, undefined);
});

test("web search mode omits the schema and keeps its cost limits", async () => {
  useSettings({ useWebSearch: true });
  mockApi(reply(good));
  await evaluateListing(listing);
  const [body] = requests;
  assert.equal(body.output_config, undefined);
  assert.equal(body.tools[0].max_uses, 2);
  assert.deepEqual(body.cache_control, { type: "ephemeral" });
});

test("sends effort alongside the schema only to models that accept it", async () => {
  useSettings({ model: "claude-sonnet-4-6" });
  mockApi(reply(good));
  await evaluateListing(listing);
  assert.equal(requests[0].output_config.effort, "medium");
  assert.ok(requests[0].output_config.format);
});

test("retries once after malformed JSON, then succeeds", async () => {
  mockApi(reply("{not json"), reply(good));
  const v = await evaluateListing(listing);
  assert.equal(requests.length, 2);
  assert.equal(v.score, 60);
});

test("rejects after two invalid answers, with no third call", async () => {
  mockApi(reply("{not json"), reply("still not json"));
  await assert.rejects(evaluateListing(listing), (err) => {
    assert.ok(err instanceof VerdictRejectedError);
    assert.match(err.message, /valid JSON/);
    return true;
  });
  assert.equal(requests.length, 2);
});

test("rejects contradictory output: high score with an Overpriced label", async () => {
  const contradictory = { ...good, score: 95, verdict: "Overpriced" };
  mockApi(reply(contradictory), reply(contradictory));
  await assert.rejects(evaluateListing(listing), /contradicts its score/);
  assert.equal(requests.length, 2);
});

test("gives a retry more room after output was cut off", async () => {
  mockApi(reply('{"score": 60, "ver', "max_tokens"), reply(good));
  await evaluateListing(listing);
  assert.ok(requests[1].max_tokens > requests[0].max_tokens);
});

test("doesn't retry a refusal", async () => {
  mockApi(reply("", "refusal"));
  await assert.rejects(evaluateListing(listing), /declined/);
  assert.equal(requests.length, 1);
});

test("doesn't treat a missing API key as a rejected answer", async () => {
  useSettings({ anthropicKey: "" });
  await assert.rejects(evaluateListing(listing), (err) => {
    assert.equal(err instanceof VerdictRejectedError, false);
    return /API key/.test(err.message);
  });
});
