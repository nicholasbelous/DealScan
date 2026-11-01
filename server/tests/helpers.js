// Test setup: an in-memory database and a mocked Anthropic API.
// These tests never call the real API.

import { buildApp } from "../src/app.js";
import { openDb } from "../src/db.js";
import { createToken } from "../src/tokens.js";

export const LISTING = {
  itemId: "1110001",
  title: "Fake Road Bike",
  price: 100,
  priceRaw: "$100",
  currency: "$",
  condition: "Used",
  category: "sports",
  description: "A made-up bike.",
  location: "Faketown",
  attributes: null,
};

export const GOOD_ANSWER = {
  score: 60,
  verdict: "Fair",
  recommendation: "Negotiate",
  marketLow: 80,
  marketHigh: 120,
  suggestedOffer: 90,
  summary: "Fine.",
};

export const apiReply = (body, stop_reason = "end_turn") => ({
  stop_reason,
  content: [{ type: "text", text: typeof body === "string" ? body : JSON.stringify(body) }],
  usage: { input_tokens: 1000, output_tokens: 100 },
});

export function mockAnthropic(...replies) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body), headers: init.headers });
    const next = replies.shift();
    if (!next) throw new Error("made more API calls than expected");
    if (next.httpStatus) {
      return { ok: false, status: next.httpStatus, headers: new Headers(), text: async () => "bad" };
    }
    return { ok: true, json: async () => next };
  };
  return calls;
}

export function setup(overrides = {}) {
  const db = openDb(":memory:");
  const config = {
    anthropicKey: "sk-ant-fake-server-key",
    dailyBudgetUsd: 1,
    cacheTtlMs: 3_600_000,
    rateLimitPerMinute: 1000,
    ...overrides.config,
  };
  const app = buildApp({ db, config, ...overrides.app });
  const token = createToken(db, "fake-user");
  const post = (body, authToken = token) =>
    app.inject({
      method: "POST",
      url: "/v1/evaluate",
      headers: authToken ? { authorization: `Bearer ${authToken}` } : {},
      payload: body,
    });
  return { app, db, config, token, post };
}
