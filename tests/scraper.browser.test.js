// Runs the real scraper.js against fake pages in headless Chrome, because panel
// scoping can't be tested without a real DOM. All IDs and titles are made up.
// Skipped if Chrome isn't installed (set CHROME_PATH to point at it).

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import { parseListing } from "../src/shared/parser.js";

const ITEM = "1110001";
const PREVIOUS = "1110002";
const SELLER = "9990009";
const TITLE = "Fake Road Bike";

const CHROME = [
  process.env.CHROME_PATH,
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].find((p) => p && fs.existsSync(p));

const scraperSource = fs.readFileSync(new URL("../src/content/scraper.js", import.meta.url), "utf8");

const sellerLink = (id) => `<a href="/marketplace/profile/${SELLER}/?product_id=${id}">Seller</a>`;
const feedCard = (id, title, price, extra = "") =>
  `<a aria-label="${title}, ${price}, Faketown, listing ${id}" href="/marketplace/item/${id}/?ref=fake">
     <span>${title}</span><span>${price}</span>${extra}</a>`;
const otherCard = feedCard("1110099", "Fake Other Thing", "$5");
const panel = (links, title = TITLE, price = "$250") =>
  `<section><h1>${title}</h1><span>${price}</span>
     <div>A made-up description that is long enough to be picked as the description text.</div>
     ${links}</section>`;
const page = (body, title = `(1) Marketplace - ${TITLE} | Facebook`) =>
  `<!doctype html><title>${title}</title><div role="main">${body}</div>`;

let pages = {};
let server, chrome, sessionId, tmp, port;
let msgId = 0;
const pending = {};

function send(method, params = {}, session) {
  return new Promise((resolve) => {
    const id = ++msgId;
    pending[id] = resolve;
    chrome.stdio[3].write(`${JSON.stringify({ id, method, params, sessionId: session })}\0`);
  });
}

async function scrape(html) {
  pages[ITEM] = html;
  await send("Page.enable", {}, sessionId);
  const loaded = new Promise((resolve) => (pending.load = resolve));
  await send("Page.navigate", { url: `http://localhost:${port}/marketplace/item/${ITEM}/?ref=x` }, sessionId);
  await loaded;
  const expression = `(() => {
    let handler;
    window.chrome = { runtime: { onMessage: { addListener: (h) => (handler = h) } } };
    console.debug = () => {};
    ${scraperSource}
    let out;
    handler({ type: "SCRAPE_LISTING" }, null, (r) => (out = r));
    return out;
  })()`;
  const res = await send("Runtime.evaluate", { expression, returnByValue: true }, sessionId);
  const out = res.result.result.value;
  assert.equal(out?.ok, true, JSON.stringify(res.result.exceptionDetails ?? out));
  return out.data;
}

before(async () => {
  if (!CHROME) return;
  server = http
    .createServer((req, res) => {
      const id = req.url.match(/item\/(\d+)/)?.[1];
      res.setHeader("content-type", "text/html");
      res.end(pages[id] ?? "");
    })
    .listen(0);
  port = server.address().port;
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "dealscan-test-"));
  chrome = spawn(
    CHROME,
    ["--headless=new", "--no-first-run", "--disable-gpu", `--user-data-dir=${tmp}`, "--remote-debugging-pipe", "about:blank"],
    { stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] }
  );
  let buf = "";
  chrome.stdio[4].on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\0")) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      if (m.method === "Page.loadEventFired") pending.load?.();
      if (pending[m.id]) {
        pending[m.id](m);
        delete pending[m.id];
      }
    }
  });
  const { result } = await send("Target.createTarget", { url: "about:blank" });
  sessionId = (await send("Target.attachToTarget", { targetId: result.targetId, flatten: true })).result.sessionId;
});

after(() => {
  chrome?.kill();
  server?.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
});

const opts = { skip: CHROME ? false : "Chrome not found" };

test("accepts a matching panel product_id", opts, async () => {
  const raw = await scrape(page(otherCard + panel(sellerLink(ITEM) + sellerLink(ITEM))));
  const listing = parseListing(raw);
  assert.equal(listing.reliable, true, listing.rejectReason);
  assert.equal(listing.verifiedBy, "panel_product_id");
  assert.equal(listing.title, TITLE);
  assert.equal(listing.price, 250);
  assert.match(listing.description, /made-up description/);
});

test("rejects a panel product_id from the previous listing as still switching", opts, async () => {
  const listing = parseListing(await scrape(page(otherCard + panel(sellerLink(PREVIOUS)))));
  assert.equal(listing.reliable, false);
  assert.match(listing.rejectReason, /still switching/);
});

test("rejects a product_id that is only in the feed, not the panel", opts, async () => {
  const card = feedCard(PREVIOUS, "Fake Other Bike", "$9", sellerLink(ITEM));
  const listing = parseListing(await scrape(page(card + panel(""))));
  assert.equal(listing.reliable, false);
  assert.match(listing.rejectReason, /confirm/);
});

test("rejects when the feed card disagrees on price", opts, async () => {
  const card = feedCard(ITEM, TITLE, "$999");
  const listing = parseListing(await scrape(page(card + panel(sellerLink(ITEM)))));
  assert.equal(listing.reliable, false);
  assert.match(listing.rejectReason, /search result/);
});

test("accepts when the feed card agrees", opts, async () => {
  const card = feedCard(ITEM, TITLE, "$250");
  const listing = parseListing(await scrape(page(card + panel(sellerLink(ITEM)))));
  assert.equal(listing.reliable, true, listing.rejectReason);
});

test("ignores a feed card for an ID that only shares a prefix", opts, async () => {
  const card = feedCard(`${ITEM}9`, TITLE, "$999");
  const listing = parseListing(await scrape(page(card + panel(sellerLink(ITEM)))));
  assert.equal(listing.reliable, true, listing.rejectReason);
});

test("still accepts with no feed card on the page", opts, async () => {
  const listing = parseListing(await scrape(page(panel(sellerLink(ITEM)))));
  assert.equal(listing.reliable, true, listing.rejectReason);
});

test("rejects when document.title doesn't contain the panel's title", opts, async () => {
  const html = page(panel(sellerLink(ITEM)), "(1) Marketplace - Fake Old Sofa | Facebook");
  const listing = parseListing(await scrape(html));
  assert.equal(listing.reliable, false);
  assert.match(listing.rejectReason, /page title/);
});

test("rejects a panel holding two different product_ids", opts, async () => {
  const listing = parseListing(await scrape(page(panel(sellerLink(ITEM) + sellerLink(PREVIOUS)))));
  assert.equal(listing.reliable, false);
});

test("rejects a page with no panel link and no embedded data", opts, async () => {
  const listing = parseListing(await scrape(page(panel(""))));
  assert.equal(listing.reliable, false);
  assert.match(listing.rejectReason, /confirm/);
});

test("a full reload still passes on embedded data, with its bare title", opts, async () => {
  const data = { id: ITEM, marketplace_listing_title: TITLE, listing_price: { formatted_amount: "$250" } };
  const html = page(`<script type="application/json">${JSON.stringify({ a: data })}</script>`, TITLE);
  const listing = parseListing(await scrape(html));
  assert.equal(listing.reliable, true, listing.rejectReason);
  assert.equal(listing.verifiedBy, "embedded_data");
});

test("embedded data doesn't override a panel showing another listing", opts, async () => {
  const data = { id: ITEM, marketplace_listing_title: TITLE, listing_price: { formatted_amount: "$250" } };
  const script = `<script type="application/json">${JSON.stringify({ a: data })}</script>`;
  const listing = parseListing(await scrape(page(script + panel(sellerLink(PREVIOUS)))));
  assert.equal(listing.reliable, false);
  assert.match(listing.rejectReason, /still switching/);
});

test("accepts a Free price in the panel", opts, async () => {
  const listing = parseListing(await scrape(page(panel(sellerLink(ITEM), TITLE, "Free"))));
  assert.equal(listing.reliable, true, listing.rejectReason);
  assert.equal(listing.price, 0);
});

test("never exposes the seller's profile ID or link", opts, async () => {
  const raw = await scrape(page(panel(sellerLink(ITEM))));
  assert.equal(JSON.stringify(raw).includes(SELLER), false);
  assert.equal(JSON.stringify(raw).includes("/profile/"), false);
});
