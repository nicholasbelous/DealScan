// Turn a saved Facebook page into a fake fixture you can review and commit.
//
//   npm run fixture:sanitize -- tests/fixtures/raw/normal.html --item-id <id> --expect reliable
//
// The raw file stays in tests/fixtures/raw/ and the result goes to
// tests/fixtures/review/. Both are gitignored. Nothing reaches git until you've
// read the output and moved it to tests/fixtures/ yourself.
// Options: --expect reliable|rejected, --out <dir>

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { parseListing } from "../src/shared/parser.js";
import { findLeaks, preStrip } from "./lib/fixture-checks.js";
import { findChrome, launchChrome } from "./lib/chrome.js";
import { runScraper } from "./lib/run-scraper.js";
import {
  FAKE_ITEM_ID_PREFIX,
  FAKE_PHOTO_HOST,
  FAKE_PROFILE_ID_PREFIX,
  sanitizeInPage,
} from "./lib/sanitize-page.js";

const USAGE = "Usage: npm run fixture:sanitize -- <raw.html> --item-id <id> --expect reliable|rejected [--out dir]";

const args = process.argv.slice(2);
const option = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const inputFile = args.find((arg, i) => !arg.startsWith("--") && !args[i - 1]?.startsWith("--"));
const itemId = option("item-id");
const expected = option("expect");
const outDir = option("out") ?? "tests/fixtures/review";

function stop(message) {
  console.error(message);
  process.exit(1);
}

if (!inputFile || !/^\d+$/.test(itemId ?? "") || !["reliable", "rejected"].includes(expected)) stop(USAGE);
if (!fs.existsSync(inputFile)) stop(`Not found: ${inputFile}`);

const CHROME = findChrome();
if (!CHROME) stop("Chrome is needed to sanitize a page. Set CHROME_PATH if it's somewhere unusual.");

const ids = { itemPrefix: FAKE_ITEM_ID_PREFIX, profilePrefix: FAKE_PROFILE_ID_PREFIX, photoHost: FAKE_PHOTO_HOST };
const pages = { raw: preStrip(fs.readFileSync(inputFile, "utf8")), clean: "" };

// Local only. The browser can't resolve any other host, so a saved page can't
// phone home, and the page's own scripts never run.
const server = http
  .createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(req.url.startsWith("/clean/") ? pages.clean : pages.raw);
  })
  .listen(0, "127.0.0.1");
await new Promise((resolve) => server.once("listening", resolve));
const origin = `http://localhost:${server.address().port}`;

const chrome = await launchChrome(CHROME, ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost"]);
let failed = null;

try {
  const page = await chrome.newPage();
  await page.send("Emulation.setScriptExecutionDisabled", { value: true });
  await page.navigate(`${origin}/raw/`);
  const result = await page.evaluate(`(${sanitizeInPage.toString()})(${JSON.stringify({ itemId, ...ids })})`);

  const problems = findLeaks(result.html, result.originals, ids);
  if (problems.length > 0) {
    failed = `Nothing was written. The output still has problems:\n- ${problems.join("\n- ")}`;
  } else {
    pages.clean = `<!DOCTYPE html>\n${result.html}\n`;

    // Does the real scraper read the sanitized page the way you expect?
    const check = await chrome.newPage();
    await check.navigate(`${origin}/clean/marketplace/item/${result.fakeItemId}/`);
    const listing = parseListing({
      ...(await runScraper(check)),
      url: `https://www.facebook.com/marketplace/item/${result.fakeItemId}/`,
    });
    const got = listing.reliable ? "reliable" : "rejected";

    fs.mkdirSync(outDir, { recursive: true });
    const name = path.basename(inputFile);
    const outFile = path.join(outDir, name);
    const header = `<!-- dealscan-fixture item-id=${result.fakeItemId} expect=${expected} -->\n`;
    fs.writeFileSync(outFile, header + pages.clean);

    console.log(`Wrote ${outFile}`);
    console.log(`Replaced ${result.replacedCount} values. Facebook labels kept as is: ${result.labelsKept.join(", ") || "none"}`);
    console.log(`The scraper reads it as: ${got}${listing.reliable ? ` (${listing.verifiedBy})` : ` (${listing.rejectReason})`}`);
    if (got !== expected) console.log(`WARNING: you expected ${expected}. The structure may not match what the scraper needs.`);
    console.log("Read the whole file. Only if it's clean, move it to tests/fixtures/ to commit it.");
  }
} finally {
  chrome.close();
  server.close();
}

if (failed) stop(failed);
