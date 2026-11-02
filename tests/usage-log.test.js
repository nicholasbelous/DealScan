// The local usage log and read rejection log, with chrome.storage stubbed.

import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import {
  appendGateRejection,
  appendUsage,
  clearGateRejections,
  clearUsageLog,
  getGateRejections,
  getUsageLog,
} from "../src/shared/storage.js";

let store;

beforeEach(() => {
  store = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: (key, cb) => cb({ [key]: store[key] }),
        set: (obj, cb) => {
          Object.assign(store, obj);
          cb();
        },
      },
    },
  };
});

test("appends newest first with a timestamp", async () => {
  await appendUsage({ status: "valid", costUsd: 1 });
  await appendUsage({ status: "rejected", costUsd: 2 });
  const log = await getUsageLog();
  assert.deepEqual(log.map((r) => r.status), ["rejected", "valid"]);
  assert.equal(typeof log[0].at, "number");
});

test("keeps the log small", async () => {
  for (let i = 0; i < 505; i++) await appendUsage({ status: "valid", costUsd: i });
  const log = await getUsageLog();
  assert.equal(log.length, 500);
  assert.equal(log[0].costUsd, 504);
});

test("clears", async () => {
  await appendUsage({ status: "valid" });
  await clearUsageLog();
  assert.deepEqual(await getUsageLog(), []);
});

test("logs gate rejections newest first, separately from usage, and clears", async () => {
  await appendGateRejection({ reason: "first", verifiedBy: null, itemId: "1" });
  await appendGateRejection({ reason: "second", verifiedBy: "embedded_data", itemId: "2" });
  const log = await getGateRejections();
  assert.deepEqual(log.map((r) => r.reason), ["second", "first"]);
  assert.deepEqual(Object.keys(log[0]).sort(), ["at", "itemId", "reason", "verifiedBy"]);
  assert.deepEqual(await getUsageLog(), []);
  await clearGateRejections();
  assert.deepEqual(await getGateRejections(), []);
});
