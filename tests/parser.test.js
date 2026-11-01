import test from "node:test";
import assert from "node:assert/strict";

import { checkRead } from "../src/shared/gate.js";
import { parsePrice } from "../src/shared/normalize.js";
import { canReuseVerdict, parseListing } from "../src/shared/parser.js";

const goodRead = (overrides = {}) => ({
  url: "https://www.facebook.com/marketplace/item/123/?ref=search",
  verifiedItemId: "123",
  transitioning: false,
  title: "Honda  Civic",
  price: "$1,200",
  description: "Runs well",
  images: ["https://cdn.example/a.jpg", "http://cdn.example/b.jpg"],
  ...overrides,
});

// --- parsePrice ---------------------------------------------------------------

test("parsePrice reads formatted prices", () => {
  assert.equal(parsePrice("$1,200"), 1200);
  assert.equal(parsePrice("$1,234.56"), 1234.56);
  assert.equal(parsePrice("$0"), 0);
});

test("parsePrice treats Free as 0, in any case", () => {
  for (const text of ["Free", "FREE", "free", " Free "]) {
    assert.equal(parsePrice(text), 0);
  }
});

test("parsePrice returns null for a missing price", () => {
  assert.equal(parsePrice(null), null);
  assert.equal(parsePrice(undefined), null);
  assert.equal(parsePrice(""), null);
});

test("parsePrice returns null for garbage", () => {
  assert.equal(parsePrice("call for price"), null);
  assert.equal(parsePrice("call, thanks"), null);
  assert.equal(parsePrice("freezer"), null);
});

// --- The gate -----------------------------------------------------------------

test("gate accepts a matching item ID", () => {
  assert.deepEqual(checkRead(goodRead()), { reliable: true, reason: null });
});

test("gate rejects a mismatched item ID", () => {
  const { reliable, reason } = checkRead(goodRead({ verifiedItemId: "456" }));
  assert.equal(reliable, false);
  assert.match(reason, /different listing/);
});

test("gate rejects an ID that only shares a prefix with the URL's", () => {
  assert.equal(checkRead(goodRead({ verifiedItemId: "1234" })).reliable, false);
  assert.equal(checkRead(goodRead({ verifiedItemId: "12" })).reliable, false);
});

test("gate rejects a read with no verified ID, even with title and price", () => {
  const { reliable, reason } = checkRead(goodRead({ verifiedItemId: null }));
  assert.equal(reliable, false);
  assert.match(reason, /confirm/);
});

test("gate rejects a URL with no item ID", () => {
  const { reliable, reason } = checkRead(
    goodRead({ url: "https://www.facebook.com/marketplace/" })
  );
  assert.equal(reliable, false);
  assert.match(reason, /address/);
});

test("gate rejects mid-navigation, even with a matching ID", () => {
  const { reliable, reason } = checkRead(goodRead({ transitioning: true }));
  assert.equal(reliable, false);
  assert.match(reason, /switching/);
});

test("gate rejects a missing title or price", () => {
  assert.equal(checkRead(goodRead({ title: "  " })).reliable, false);
  assert.equal(checkRead(goodRead({ price: null })).reliable, false);
  assert.equal(checkRead(goodRead({ price: "call for price" })).reliable, false);
});

test("gate accepts a Free listing", () => {
  assert.equal(checkRead(goodRead({ price: "Free" })).reliable, true);
});

test("gate rejects a panel read whose title isn't in document.title", () => {
  const { reliable, reason } = checkRead(
    goodRead({ verifiedBy: "panel_product_id", titleInDocument: false })
  );
  assert.equal(reliable, false);
  assert.match(reason, /page title/);
});

const panelRead = (feedCardLabel) =>
  goodRead({
    verifiedBy: "panel_product_id",
    titleInDocument: true,
    title: "Fake Bike",
    price: "$1,200",
    feedCardLabel,
  });

test("gate accepts a panel read with no feed card", () => {
  assert.equal(checkRead(panelRead(null)).reliable, true);
});

test("gate accepts a feed card that agrees, including a comma in the title", () => {
  assert.equal(checkRead(panelRead("Fake Bike, $1,200, Faketown, listing 123")).reliable, true);
  const read = { ...panelRead("Red, fast bike, $1,200, Faketown, listing 123"), title: "Red, fast bike" };
  assert.equal(checkRead(read).reliable, true);
});

test("gate rejects a feed card that disagrees on price or title", () => {
  assert.match(checkRead(panelRead("Fake Bike, $900, Faketown, listing 123")).reason, /search result/);
  assert.match(checkRead(panelRead("Other Bike, $1,200, Faketown, listing 123")).reason, /search result/);
});

test("gate doesn't reject on a feed card price it can't parse", () => {
  assert.equal(checkRead(panelRead("Fake Bike, Faketown, listing 123")).reliable, true);
});

// --- parseListing -------------------------------------------------------------

test("parseListing normalizes a good read", () => {
  const listing = parseListing(goodRead());
  assert.equal(listing.reliable, true);
  assert.equal(listing.rejectReason, null);
  assert.equal(listing.url, "https://www.facebook.com/marketplace/item/123/");
  assert.equal(listing.title, "Honda Civic");
  assert.equal(listing.price, 1200);
  assert.equal(listing.priceRaw, "$1,200");
  assert.equal(listing.currency, "$");
  assert.deepEqual(listing.images, ["https://cdn.example/a.jpg"]);
});

test("parseListing carries the gate's decision and reason", () => {
  const listing = parseListing(goodRead({ verifiedItemId: "456" }));
  assert.equal(listing.reliable, false);
  assert.match(listing.rejectReason, /different listing/);
});

test("parseListing records the verification method only when reliable", () => {
  assert.equal(parseListing(goodRead({ verifiedBy: "embedded_data" })).verifiedBy, "embedded_data");
  assert.equal(
    parseListing(goodRead({ verifiedBy: "embedded_data", verifiedItemId: "456" })).verifiedBy,
    null
  );
});

test("parseListing carries the verified item ID only when reliable", () => {
  assert.equal(parseListing(goodRead()).itemId, "123");
  assert.equal(parseListing(goodRead({ verifiedItemId: "456" })).itemId, null);
});

test("parseListing keeps a Free listing at price 0", () => {
  const listing = parseListing(goodRead({ price: "Free" }));
  assert.equal(listing.reliable, true);
  assert.equal(listing.price, 0);
});

test("parseListing never includes seller fields", () => {
  const listing = parseListing(goodRead({ seller: "Jane Doe" }));
  assert.equal("seller" in listing, false);
});

test("parseListing throws when nothing was scraped", () => {
  assert.throws(() => parseListing(null), /Nothing scraped/);
});

// --- canReuseVerdict ----------------------------------------------------------

test("replaces a no-photos verdict when the new read offers more photos", () => {
  assert.equal(canReuseVerdict({ imagesAnalyzed: 0, imagesOffered: 0 }, 3), false);
  assert.equal(canReuseVerdict({ imagesAnalyzed: 0, imagesOffered: 1 }, 3), false);
});

test("reuses a no-photos verdict when photos offered again failed to load", () => {
  assert.equal(canReuseVerdict({ imagesAnalyzed: 0, imagesOffered: 3 }, 3), true);
});

test("reuses a no-photos verdict when the read has no photos", () => {
  assert.equal(canReuseVerdict({ imagesAnalyzed: 0, imagesOffered: 0 }, 0), true);
});

test("reuses a verdict that already had photos", () => {
  assert.equal(canReuseVerdict({ imagesAnalyzed: 2, imagesOffered: 2 }, 3), true);
});
