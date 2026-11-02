// Runs the real scraper.js against fake pages in headless Chrome, because panel
// scoping can't be tested without a real DOM. All IDs and titles are made up.
// Without Chrome these skip on a developer's machine but FAIL in CI, so a missing
// browser can never pass silently. Set CHROME_PATH to choose a specific binary.

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

import { IN_CI, findChrome, launchChrome } from "../scripts/lib/chrome.js";
import { runScraper } from "../scripts/lib/run-scraper.js";
import { parseListing } from "../src/shared/parser.js";

const ITEM = "1110001";
const PREVIOUS = "1110002";
const SELLER = "9990009";
const TITLE = "Fake Road Bike";

const CHROME = findChrome();

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
let server, chrome, tab, port;

async function scrape(html) {
  pages[ITEM] = html;
  await tab.navigate(`http://localhost:${port}/marketplace/item/${ITEM}/?ref=x`);
  return runScraper(tab);
}

before(async () => {
  if (!CHROME) {
    if (IN_CI) throw new Error("Chrome not found in CI: the scraper tests can't run.");
    return;
  }
  server = http
    .createServer((req, res) => {
      const id = req.url.match(/item\/(\d+)/)?.[1];
      res.setHeader("content-type", "text/html");
      res.end(pages[id] ?? "");
    })
    .listen(0);
  port = server.address().port;
  chrome = await launchChrome(CHROME);
  tab = await chrome.newPage();
});

after(() => {
  chrome?.close();
  server?.close();
});

const opts = { skip: CHROME || IN_CI ? false : "Chrome not found" };

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

test("the location stops at its own element, not the text after it", opts, async () => {
  const links = `<div>Listed 2 days ago in Faketown, WA</div><div><span>Condition</span> <span>Used</span></div>${sellerLink(ITEM)}`;
  const listing = parseListing(await scrape(page(panel(links))));
  assert.equal(listing.location, "Faketown, WA");
  assert.equal(listing.condition, "Used");
});

test("never exposes the seller's profile ID or link", opts, async () => {
  const raw = await scrape(page(panel(sellerLink(ITEM))));
  assert.equal(JSON.stringify(raw).includes(SELLER), false);
  assert.equal(JSON.stringify(raw).includes("/profile/"), false);
});
