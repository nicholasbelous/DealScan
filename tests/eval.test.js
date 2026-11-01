// The eval harness with mocks only. Nothing here can reach the real API: the paid
// path is only ever tested for refusing to start.

import { after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseCsv, parseLabels, saveLabels } from "../eval/labels.js";
import { loadEvalSet, planRuns, runEval } from "../eval/harness.js";
import { costAndLatency, priceRangeHitRate, rejectionPrecision, scoreVariance } from "../eval/metrics.js";
import { openDb } from "../server/src/db.js";
import { rememberListing } from "../server/src/store.js";
import { VerdictRejectedError } from "../src/shared/verdict.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dealscan-eval-"));
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const label = (o = {}) => ({ item_id: "1", human_price_low: 100, human_price_high: 200, readable: 1, ...o });
const valid = (marketLow, marketHigh, score = 60, evaluation = { attempts: 1, costUsd: 1, latencyMs: 10 }) => ({
  status: "valid",
  verdict: { marketLow, marketHigh, score },
  evaluation,
});

// --- CSV and labels ----------------------------------------------------------------

test("parses quotes, commas, and doubled quotes", () => {
  assert.deepEqual(parseCsv('a,"b, c","d ""e"""\r\n1,2,3\n'), [["a", "b, c", 'd "e"'], ["1", "2", "3"]]);
});

test("the template parses and holds only fake rows", () => {
  const text = fs.readFileSync(new URL("../eval/labels.template.csv", import.meta.url), "utf8");
  const { labels, errors } = parseLabels(text);
  assert.deepEqual(errors, []);
  assert.equal(labels.length, 3);
  for (const l of labels) assert.match(l.title, /^Fake/);
  assert.equal(labels[2].readable, false);
});

test("names every bad line", () => {
  const { errors } = parseLabels(
    [
      "item_id,title,my_price_low,my_price_high,readable,notes",
      "abc,T,1,2,true,",
      "1,T,5,2,true,",
      "2,T,,,true,",
      "3,T,1,2,maybe,",
      "3,T,1,2,true,",
      "3,T,1,2,true,",
    ].join("\n")
  );
  assert.equal(errors.length, 6);
  assert.match(errors[0], /Line 2/);
  assert.match(errors[5], /Line 7: duplicate/);
});

test("refuses the wrong header", () => {
  assert.match(parseLabels("a,b\n1,2").errors[0], /header/);
});

test("saves labels and updates on re-import", () => {
  const db = openDb(":memory:");
  const l = { itemId: "1", title: "Fake", priceLow: 1, priceHigh: 2, readable: true, notes: null };
  saveLabels(db, [l]);
  saveLabels(db, [{ ...l, priceHigh: 9 }]);
  const rows = db.prepare("SELECT * FROM labels").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].human_price_high, 9);
});

// --- Metrics -----------------------------------------------------------------------

test("price range hit rate: overlap counts, including touching edges", () => {
  const results = [
    { label: label(), runs: [valid(150, 180)] },
    { label: label(), runs: [valid(200, 300)] },
    { label: label(), runs: [valid(50, 100)] },
    { label: label(), runs: [valid(300, 400)] },
    { label: label(), runs: [valid(10, 20)] },
  ];
  assert.deepEqual(priceRangeHitRate(results), { hits: 3, total: 5, rate: 0.6 });
});

test("price range hit rate: skips unreadable and rejected, and uses the first run", () => {
  const results = [
    { label: label({ readable: 0 }), runs: [valid(150, 180)] },
    { label: label(), runs: [{ status: "rejected" }] },
    { label: label(), runs: [valid(10, 20), valid(150, 180)] },
  ];
  assert.deepEqual(priceRangeHitRate(results), { hits: 0, total: 1, rate: 0 });
});

test("price range hit rate: null when nothing was scored, not 0", () => {
  assert.equal(priceRangeHitRate([]).rate, null);
});

test("score variance: spread per listing, only for repeated listings", () => {
  const runs = (scores) => scores.map((s) => valid(1, 2, s));
  const v = scoreVariance(
    [
      { label: label({ item_id: "a" }), runs: runs([50, 60, 55, 50, 52]) },
      { label: label({ item_id: "b" }), runs: runs([70, 70, 70, 70, 70]) },
      { label: label({ item_id: "c" }), runs: runs([10]) },
    ],
    5
  );
  assert.deepEqual(v.listings.map((l) => l.spread), [10, 0]);
  assert.equal(v.maxSpread, 10);
});

test("rejection precision: rejected listings my labels call unreadable", () => {
  const p = rejectionPrecision([
    { label: label({ readable: 0 }), runs: [{ status: "rejected" }] },
    { label: label(), runs: [{ status: "rejected" }] },
    { label: label(), runs: [{ status: "rejected" }] },
    { label: label(), runs: [valid(1, 2)] },
  ]);
  assert.equal(p.hits, 1);
  assert.equal(p.total, 3);
  assert.match(p.scope, /gate rejections/);
  assert.equal(rejectionPrecision([]).rate, null);
});

test("cost and latency include rejections and skip calls that never reached the API", () => {
  const c = costAndLatency([
    { label: label(), runs: [valid(1, 2, 60, { attempts: 1, costUsd: 1, latencyMs: 100 })] },
    { label: label(), runs: [{ status: "rejected", evaluation: { attempts: 2, costUsd: 3, latencyMs: 300 } }] },
    { label: label(), runs: [{ status: "error", evaluation: { attempts: 0, costUsd: 0, latencyMs: 1 } }] },
  ]);
  assert.equal(c.runs, 2);
  assert.equal(c.costUsd.total, 4);
  assert.equal(c.costUsd.p90, 3);
  assert.equal(c.latencyMs.median, 100);
});

// --- Harness -----------------------------------------------------------------------

function seededDb(count) {
  const db = openDb(":memory:");
  const labels = [];
  for (let i = 1; i <= count; i++) {
    labels.push({ itemId: String(i), title: `Fake ${i}`, priceLow: 80, priceHigh: 120, readable: true, notes: null });
    rememberListing(db, String(i), "h", { title: `Fake ${i}`, price: 100 }, i);
  }
  saveLabels(db, labels);
  return db;
}

test("plans 5 listings x 5 runs, then one run each", () => {
  const { ready } = loadEvalSet(seededDb(7));
  assert.deepEqual(planRuns(ready).map((p) => p.runCount), [5, 5, 5, 5, 5, 1, 1]);
});

test("reports labels with no stored listing instead of guessing a price", () => {
  const db = seededDb(1);
  saveLabels(db, [{ itemId: "99", title: "Fake", priceLow: 1, priceHigh: 2, readable: true, notes: null }]);
  const { ready, missing } = loadEvalSet(db);
  assert.equal(ready.length, 1);
  assert.deepEqual(missing, ["99"]);
});

test("runs with an injected evaluator, recording rejections and errors", async () => {
  const { ready } = loadEvalSet(seededDb(3));
  const planned = planRuns(ready).map((p) => ({ ...p, runCount: 1 }));
  const outcomes = [
    async () => ({ score: 60, marketLow: 90, marketHigh: 110, evaluation: { attempts: 1, costUsd: 1, latencyMs: 5 } }),
    async () => {
      const err = new VerdictRejectedError("bad");
      err.evaluation = { attempts: 2, costUsd: 2, latencyMs: 9 };
      throw err;
    },
    async () => {
      throw new Error("network");
    },
  ];
  const { results, metrics } = await runEval(planned, () => outcomes.shift()());
  assert.deepEqual(results.map((r) => r.runs[0].status), ["valid", "rejected", "error"]);
  assert.equal(metrics.priceRangeHitRate.rate, 1);
  assert.equal(metrics.costAndLatency.costUsd.total, 3);
});

// --- The CLI: spending guard and mock run ---------------------------------------------

function seedFile(name, count = 6) {
  const file = path.join(tmp, name);
  const db = openDb(file);
  const labels = [];
  for (let i = 1; i <= count; i++) {
    labels.push({ itemId: String(i), title: `Fake ${i}`, priceLow: 80, priceHigh: 120, readable: true, notes: null });
    rememberListing(db, String(i), "h", { title: `Fake ${i}`, price: 100 }, i);
  }
  saveLabels(db, labels);
  db.close();
  return file;
}

function cli(args, env = {}) {
  const clean = { PATH: process.env.PATH, ...env };
  return spawnSync(process.execPath, ["eval/run.js", ...args], { env: clean, encoding: "utf8", cwd: new URL("..", import.meta.url) });
}

test("with no flag it shows the plan and refuses, even with a key set", () => {
  const db = seedFile("plan.db");
  const res = cli(["--db", db, "--out", path.join(tmp, "plan")], { ANTHROPIC_API_KEY: "sk-ant-fake" });
  assert.equal(res.status, 1);
  assert.match(res.stdout, /Plan: 6 listing\(s\), 26 evaluation\(s\)/);
  assert.match(res.stderr, /real money/);
  assert.equal(fs.existsSync(path.join(tmp, "plan")), false);
});

test("--confirm-paid without a key refuses", () => {
  const db = seedFile("nokey.db");
  const res = cli(["--db", db, "--confirm-paid"]);
  assert.equal(res.status, 1);
  assert.match(res.stderr, /needs ANTHROPIC_API_KEY/);
});

test("--mock runs end to end and marks its results as mock", () => {
  const db = seedFile("mock.db");
  const out = path.join(tmp, "results");
  const res = cli(["--db", db, "--mock", "--out", out]);
  assert.equal(res.status, 0, res.stderr);
  const [file] = fs.readdirSync(out);
  assert.match(file, /-MOCK\.json$/);
  const report = JSON.parse(fs.readFileSync(path.join(out, file), "utf8"));
  assert.equal(report.mock, true);
  assert.equal(report.results.length, 6);
  assert.equal(report.metrics.scoreVariance.listings.length, 5);
  assert.ok(report.metrics.priceRangeHitRate.total > 0);
  assert.ok(report.metrics.costAndLatency.costUsd.total > 0);
});

test("the import script works as documented, with no --db", () => {
  const cwd = fs.mkdtempSync(path.join(tmp, "cwd-"));
  const script = new URL("../eval/import-labels.js", import.meta.url).pathname;
  const template = new URL("../eval/labels.template.csv", import.meta.url).pathname;
  const res = spawnSync(process.execPath, [script, template], { encoding: "utf8", cwd });
  assert.equal(res.status, 0, res.stderr);
  assert.ok(fs.existsSync(path.join(cwd, "server/data/dealscan.db")));
});

test("the import script is all or nothing", () => {
  const db = path.join(tmp, "import.db");
  const bad = path.join(tmp, "bad.csv");
  fs.writeFileSync(bad, "item_id,title,my_price_low,my_price_high,readable,notes\n1,T,1,2,true,\nx,T,1,2,true,\n");
  const run = (file) =>
    spawnSync(process.execPath, ["eval/import-labels.js", file, "--db", db], {
      encoding: "utf8",
      cwd: new URL("..", import.meta.url),
    });
  const failed = run(bad);
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Line 3/);

  const ok = run(new URL("../eval/labels.template.csv", import.meta.url).pathname);
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /Imported 3 labels/);
  assert.equal(openDb(db).prepare("SELECT COUNT(*) c FROM labels").get().c, 3);
});
