// The eval harness. It costs real money against the API, so:
//   npm run eval                        shows the plan and stops
//   npm run eval -- --mock              runs against a fake API, for free
//   npm run eval -- --confirm-paid      calls the real API (needs ANTHROPIC_API_KEY)
// Options: --db <path>, --model <id>, --out <dir>

import fs from "node:fs";
import path from "node:path";

import { openDb } from "../server/src/db.js";
import { DEFAULT_MODEL, runEvaluation } from "../src/shared/anthropic.js";
import { MODEL_PRICES } from "../src/shared/pricing.js";
import { PROMPT_VERSION } from "../src/shared/prompt.js";
import { loadEvalSet, planRuns, runEval } from "./harness.js";
import { installMockApi } from "./mock-api.js";

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
};
const mock = args.includes("--mock");
const paid = args.includes("--confirm-paid");
const model = option("model", DEFAULT_MODEL);
const outDir = option("out", "eval/results");

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (!MODEL_PRICES[model]) stop(`Unknown model "${model}". Choose one with a price: ${Object.keys(MODEL_PRICES).join(", ")}`);

const { ready, missing } = loadEvalSet(openDb(option("db", "server/data/dealscan.db")));
if (missing.length > 0) {
  console.log(`Skipping ${missing.length} label(s) with no stored listing: ${missing.join(", ")}`);
  console.log("A label needs a listing evaluated through the server first, because the CSV has no asking price.");
}
if (ready.length === 0) stop("Nothing to evaluate. Import labels, and evaluate those listings in server mode first.");

const planned = planRuns(ready);
const evaluationCount = planned.reduce((sum, p) => sum + p.runCount, 0);
console.log(`Plan: ${ready.length} listing(s), ${evaluationCount} evaluation(s) on ${model}, prompt ${PROMPT_VERSION}. An invalid answer adds a retry.`);

if (!mock && !paid) stop("Stopped: this would spend real money. Add --confirm-paid to run it, or --mock to try it for free.");
if (mock && paid) stop("Choose either --mock or --confirm-paid.");

let apiKey = "mock";
if (mock) installMockApi();
else {
  apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) stop("--confirm-paid needs ANTHROPIC_API_KEY.");
}

const { results, metrics } = await runEval(planned, (listing) => runEvaluation({ apiKey, model }, listing));

const date = new Date().toISOString().slice(0, 10);
const report = {
  date,
  mock,
  promptVersion: PROMPT_VERSION,
  model,
  skippedNoListing: missing,
  caveat: "Evaluated from stored listing text, without photos, because the server doesn't keep photos.",
  metrics,
  results: results.map(({ label, runs }) => ({
    itemId: label.item_id,
    readable: Boolean(label.readable),
    runs: runs.map(({ status, reason, verdict, evaluation }) => ({
      status,
      reason,
      score: verdict?.score,
      marketLow: verdict?.marketLow,
      marketHigh: verdict?.marketHigh,
      evaluation,
    })),
  })),
};

fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${date}-${PROMPT_VERSION}${mock ? "-MOCK" : ""}.json`);
fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
console.log(JSON.stringify(metrics, null, 2));
console.log(`Wrote ${outFile}`);
