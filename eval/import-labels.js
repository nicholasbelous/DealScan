// Import labels: npm run eval:import -- <file.csv> [--db path]
// All or nothing: one bad row stops the import, with every problem listed.

import fs from "node:fs";

import { openDb } from "../server/src/db.js";
import { parseLabels, saveLabels } from "./labels.js";

const args = process.argv.slice(2);
const dbFlag = args.indexOf("--db");
const dbPath = dbFlag >= 0 ? args[dbFlag + 1] : "server/data/dealscan.db";
const file = args.find((arg, i) => !arg.startsWith("--") && i !== dbFlag + 1);

if (!file) {
  console.error("Usage: npm run eval:import -- <file.csv> [--db path]");
  process.exit(1);
}

const { labels, errors } = parseLabels(fs.readFileSync(file, "utf8"));
if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

saveLabels(openDb(dbPath), labels);
console.log(`Imported ${labels.length} label${labels.length === 1 ? "" : "s"}.`);
