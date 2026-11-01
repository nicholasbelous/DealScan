import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";

import { appendUsage, clearUsageLog, getUsageLog } from "../src/shared/storage.js";

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
