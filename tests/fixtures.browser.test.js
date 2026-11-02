// Two things: the sanitizer, run on a fake "raw" page seeded with fake secrets, and
// every reviewed fixture in tests/fixtures/. All data here is made up.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { findLeaks, preStrip } from "../scripts/lib/fixture-checks.js";
import { IN_CI, findChrome, launchChrome } from "../scripts/lib/chrome.js";
import { runScraper } from "../scripts/lib/run-scraper.js";
import { FAKE_ITEM_ID_PREFIX, FAKE_PHOTO_HOST, FAKE_PROFILE_ID_PREFIX } from "../scripts/lib/sanitize-page.js";
import { parseListing } from "../src/shared/parser.js";

const ROOT = new URL("..", import.meta.url).pathname;
const CHROME = findChrome();
const opts = { skip: CHROME || IN_CI ? false : "Chrome not found" };
const IDS = { itemPrefix: FAKE_ITEM_ID_PREFIX, profilePrefix: FAKE_PROFILE_ID_PREFIX, photoHost: FAKE_PHOTO_HOST };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dealscan-fixtures-"));

// Pretends to be a saved page. Every value is invented, but shaped like the real thing.
const SEEDS = {
  itemId: "5551112223334",
  otherItemId: "5559998887776",
  profileId: "7773334445556",
  title: "Seeded Vintage Trek Bicycle, Blue",
  price: "$1,234",
  description: "Seeded description written by Jordan Seedperson, call 555-010-9999 before you come over please.",
  sellerName: "Jordan Seedperson",
  viewerName: "Casey Viewerperson",
  otherTitle: "Seeded Other Couch",
  location: "Seedville, WA",
  token: "AQSEEDEDTOKENVALUE",
  email: "seeded.person@example.com",
};

const rawPage = (s = SEEDS) => `<!DOCTYPE html>
<html lang="en" data-viewer="${s.viewerName}">
<head>
  <title>(3) Marketplace - ${s.title} | Facebook</title>
  <meta property="og:title" content="${s.title}" />
  <meta http-equiv="refresh" content="0; url=https://mbasic.facebook.com/" />
  <base href="https://www.facebook.com/" />
  <link rel="stylesheet" href="https://static.xx.fbcdn.net/rsrc.php/real.css" />
  <style>.x1abc { color: red }</style>
  <script>require("Bootloader"); window.__user = "${s.profileId}"; document.body.innerHTML = "ran";</script>
  <script type="application/json">{"fb_dtsg":"${s.token}","c_user":"${s.profileId}","viewer":{"email":"${s.email}","name":"${s.viewerName}"}}</script>
</head>
<body class="x1abc" onload="alert(1)">
  <noscript><meta http-equiv="refresh" content="0; url=https://mbasic.facebook.com/" /></noscript>
  <!-- ${s.viewerName} -->
  <div role="banner" data-user="${s.profileId}"><span>${s.viewerName}</span><input value="${s.viewerName}" /></div>
  <div role="main" style="color:red" id="mount_0_0">
    <section class="feed">
      <a aria-label="${s.title}, ${s.price}, ${s.location}, listing ${s.itemId}" href="/marketplace/item/${s.itemId}/?ref=search&tracking=${s.token}">
        <img src="https://scontent.xx.fbcdn.net/real-photo.jpg" alt="${s.title}" /><span>${s.title}</span><span>${s.price}</span>
      </a>
      <a aria-label="${s.otherTitle}, $75, ${s.location}, listing ${s.otherItemId}" href="/marketplace/item/${s.otherItemId}/">
        <span>${s.otherTitle}</span><span>$75</span>
      </a>
    </section>
    <section class="panel" data-ft="${s.token}">
      <h1><span>${s.title}</span></h1>
      <span>${s.price}</span>
      <div>Listed 2 days ago in ${s.location}</div>
      <div><span>Condition</span> <span>Used - good</span></div>
      <div>${s.description}</div>
      <div>Driven 54,321 miles</div>
      <img src="https://scontent.xx.fbcdn.net/real-avatar.jpg" />
      <a href="/marketplace/profile/${s.profileId}/?product_id=${s.itemId}&ref=${s.token}"><span>${s.sellerName}</span></a>
      <a href="/marketplace/profile/${s.profileId}/?product_id=${s.itemId}">Seller details</a>
      <a href="https://l.facebook.com/l.php?u=https://elsewhere.example/${s.token}">A link out</a>
    </section>
  </div>
</body>
</html>`;

function sanitize(name, html, ...extra) {
  const rawFile = path.join(tmp, `${name}.html`);
  fs.writeFileSync(rawFile, html);
  const out = path.join(tmp, "review");
  const res = spawnSync(
    process.execPath,
    ["scripts/sanitize-fixture.js", rawFile, "--item-id", SEEDS.itemId, "--expect", "reliable", "--out", out, ...extra],
    { encoding: "utf8", cwd: ROOT, env: process.env }
  );
  const outFile = path.join(out, `${name}.html`);
  return { res, outFile, output: fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null };
}

let chrome, server, page, served;

before(async () => {
  if (!CHROME) {
    if (IN_CI) throw new Error("Chrome not found in CI: the fixture tests can't run.");
    return;
  }
  server = http
    .createServer((_req, res) => {
      res.setHeader("content-type", "text/html");
      res.end(served);
    })
    .listen(0);
  chrome = await launchChrome(CHROME);
  page = await chrome.newPage();
});

after(() => {
  chrome?.close();
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

async function readFixture(html) {
  const [, itemId, expect] = html.match(/dealscan-fixture item-id=(\d+) expect=(\w+)/);
  served = html;
  await page.navigate(`http://localhost:${server.address().port}/marketplace/item/${itemId}/`);
  const raw = await runScraper(page);
  return { raw, itemId, expect, listing: parseListing(raw) };
}

// --- What must never survive ----------------------------------------------------------

test("sanitizer: nothing seeded survives", opts, () => {
  const { res, output } = sanitize("normal", rawPage());
  assert.equal(res.status, 0, res.stderr);
  for (const [name, value] of Object.entries(SEEDS)) {
    assert.equal(output.includes(value), false, `${name} survived`);
  }
  for (const piece of ["Seeded", "Seedperson", "Viewerperson", "Seedville", "555-010", "54,321", "real-photo", "real-avatar", "elsewhere"]) {
    assert.equal(output.includes(piece), false, `${piece} survived`);
  }
});

test("sanitizer: scripts, session data, attributes, and redirects are all gone", opts, () => {
  const { output } = sanitize("strip", rawPage());
  for (const banned of ["fb_dtsg", "c_user", "__user", "Bootloader", "http-equiv", "<base", "<link", "<style", "onload", "data-", "class=", "style=", "<input", "<!-- Casey", "og:title"]) {
    assert.equal(output.includes(banned), false, `${banned} survived`);
  }
  assert.equal((output.match(/<script/g) ?? []).length, 0);
});

// --- What must survive, or the fixture is useless ---------------------------------------

test("sanitizer: the real scraper still verifies the result through the panel", opts, async () => {
  const { output, res } = sanitize("works", rawPage());
  assert.match(res.stdout, /reads it as: reliable \(panel_product_id\)/);
  const { listing, itemId } = await readFixture(output);
  assert.equal(listing.reliable, true, listing.rejectReason);
  assert.equal(listing.verifiedBy, "panel_product_id");
  assert.equal(listing.itemId, itemId);
  assert.ok(itemId.startsWith(FAKE_ITEM_ID_PREFIX));
  assert.match(listing.title, /^Faketext/);
  assert.ok(listing.price > 0);
  assert.equal(listing.condition, "Used - good");
  assert.match(listing.description, /^Fakeprose/);
  assert.equal(listing.location, "Fakeville");
  assert.match(listing.attributes.mileage, /miles/);
});

test("sanitizer: the search card, page title, and panel still agree", opts, async () => {
  const { output } = sanitize("agree", rawPage());
  const { raw } = await readFixture(output);
  assert.equal(raw.titleInDocument, true);
  assert.ok(raw.feedCardLabel.startsWith(`${raw.title}, ${raw.price}, `), raw.feedCardLabel);
  assert.match(raw.feedCardLabel, new RegExp(`listing ${FAKE_ITEM_ID_PREFIX}`));
});

test("sanitizer: another listing's card stays a boundary, with a different fake ID", opts, () => {
  const { output } = sanitize("cards", rawPage());
  const ids = [...output.matchAll(/\/marketplace\/item\/(\d+)\//g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, 2);
});

test("sanitizer: rebuilds embedded data from named fields only", opts, async () => {
  const data = {
    id: SEEDS.itemId,
    marketplace_listing_title: SEEDS.title,
    listing_price: { formatted_amount: "Free" },
    redacted_description: { text: SEEDS.description },
    condition: { text: "New" },
    marketplace_listing_seller: { name: SEEDS.sellerName, id: SEEDS.profileId },
    listing_photos: [{ image: { uri: "https://scontent.xx.fbcdn.net/real-listing.jpg" } }],
  };
  const html = `<!DOCTYPE html><html><head><title>${SEEDS.title}</title>
    <script type="application/json">${JSON.stringify({ wrap: { data } })}</script></head>
    <body><div role="main"><h1>${SEEDS.title}</h1></div></body></html>`;
  const { output, res } = sanitize("embedded", html);
  assert.equal(res.status, 0, res.stderr);
  assert.equal(output.includes(SEEDS.sellerName), false);
  assert.equal(output.includes("marketplace_listing_seller"), false);
  assert.equal(output.includes("real-listing"), false);

  const { listing } = await readFixture(output);
  assert.equal(listing.reliable, true, listing.rejectReason);
  assert.equal(listing.verifiedBy, "embedded_data");
  assert.equal(listing.price, 0);
  assert.equal(listing.images.length, 1);
  assert.ok(listing.images[0].includes(FAKE_PHOTO_HOST));
});

test("sanitizer: warns when the result won't read as you expected", opts, () => {
  const { res } = sanitize("expectation", rawPage().replace(/\?product_id=\d+/g, ""));
  assert.match(res.stdout, /WARNING: you expected reliable/);
});

test("sanitizer: refuses bad arguments", () => {
  const res = spawnSync(process.execPath, ["scripts/sanitize-fixture.js", "x.html"], { encoding: "utf8", cwd: ROOT });
  assert.equal(res.status, 1);
  assert.match(res.stderr, /Usage/);
});

// --- The leak check on its own -------------------------------------------------------------

test("leak check: passes clean output", () => {
  const html = `<html><head><title>Faketext 1</title></head><body><a href="/marketplace/item/9000000001/">x</a><img src="https://${FAKE_PHOTO_HOST}/fake-1.jpg"></body></html>`;
  assert.deepEqual(findLeaks(html, ["Real Title"], IDS), []);
});

test("leak check: catches each kind of problem, without repeating the value", () => {
  const cases = [
    ["<p>Real Title</p>", /replaced value/],
    ["<p>fb_dtsg</p>", /session token/],
    ["<p>someone@example.com</p>", /email/],
    ['<p style="x">a</p>', /inline style/],
    ['<p class="x">a</p>', /inline style/],
    ["<p>1234567890</p>", /long number/],
    ['<a href="https://www.facebook.com/x">a</a>', /host/],
    ["<script>x</script>", /script/],
  ];
  for (const [html, expected] of cases) {
    const problems = findLeaks(html, ["Real Title"], IDS);
    assert.ok(problems.some((p) => expected.test(p)), `${html}: ${problems}`);
    assert.equal(problems.join().includes("Real Title"), false);
  }
});

test("pre-strip removes what could redirect the page", () => {
  const out = preStrip('<noscript><meta http-equiv="refresh"></noscript><META HTTP-EQUIV="refresh"><base href="x"><p>ok</p>');
  assert.equal(out, "<p>ok</p>");
});

// --- Raw HTML can't reach git -----------------------------------------------------------------

test("raw and review folders are gitignored, with nothing tracked in them", () => {
  for (const file of ["tests/fixtures/raw/page.html", "tests/fixtures/review/page.html"]) {
    const ignored = spawnSync("git", ["check-ignore", "-q", "--no-index", file], { cwd: ROOT });
    assert.equal(ignored.status, 0, `${file} isn't ignored`);
  }
  const tracked = spawnSync("git", ["ls-files", "tests/fixtures/raw", "tests/fixtures/review"], { cwd: ROOT, encoding: "utf8" });
  assert.equal(tracked.stdout.trim(), "");
});

// --- Reviewed fixtures -----------------------------------------------------------------------

const fixturesDir = new URL("fixtures/", import.meta.url).pathname;
const fixtures = fs.readdirSync(fixturesDir).filter((f) => f.endsWith(".html"));

for (const file of fixtures) {
  test(`fixture ${file}: reads as expected, with no leaks`, opts, async () => {
    const html = fs.readFileSync(path.join(fixturesDir, file), "utf8");
    assert.deepEqual(findLeaks(html, [], IDS), []);
    const { listing, expect } = await readFixture(html);
    assert.equal(listing.reliable ? "reliable" : "rejected", expect, listing.rejectReason);
  });
}

test("reviewed fixtures", { skip: fixtures.length === 0 ? "none captured yet" : false }, () => {
  assert.ok(fixtures.length > 0);
});
