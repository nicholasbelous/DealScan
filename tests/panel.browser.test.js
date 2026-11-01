// The real side panel page in headless Chrome, with chrome.* stubbed and the
// evaluation response held open until the test releases it. This is the exact
// race: an evaluation in flight, the user moves on, then the answer arrives.
// All IDs and titles are made up. Nothing here can reach the Anthropic API.

import { after, before, beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

import { IN_CI, findChrome, launchChrome } from "../scripts/lib/chrome.js";

const CHROME = findChrome();
const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png" };
const opts = { skip: CHROME || IN_CI ? false : "Chrome not found" };

const URL_A = "https://www.facebook.com/marketplace/item/1110001/";
const URL_B = "https://www.facebook.com/marketplace/item/1110002/";

// Installed before the page's own scripts run.
const CHROME_STUB = `
  window.__t = {
    url: ${JSON.stringify(URL_A)},
    evaluations: [],
    saved: [],
    listeners: { message: [], activated: [], updated: [] },
    read(url) {
      const id = url.match(/item\\/(\\d+)/)?.[1];
      const title = id === "1110001" ? "Fake Bike A" : "Fake Sofa B";
      return { url, verifiedItemId: id, verifiedBy: "embedded_data", transitioning: false, title, price: "$100", images: [] };
    },
    navigate(url) {
      this.url = url;
      for (const l of this.listeners.message) l({ type: "LISTING_CHANGED", url });
    },
  };
  const t = window.__t;
  const store = {};
  const area = {
    get: (key, cb) => {
      const out = { [key]: store[key] };
      return cb ? cb(out) : Promise.resolve(out);
    },
    set: (obj, cb) => {
      Object.assign(store, obj);
      if (obj.history) t.saved = obj.history;
      return cb ? cb() : Promise.resolve();
    },
    remove: () => Promise.resolve(),
  };
  window.chrome = {
    runtime: {
      lastError: undefined,
      getManifest: () => ({ content_scripts: [{ js: [] }] }),
      onMessage: { addListener: (l) => t.listeners.message.push(l) },
      sendMessage: (message) =>
        new Promise((resolve) => t.evaluations.push({ title: message.payload.title, resolve })),
    },
    storage: { local: area, session: area },
    tabs: {
      query: async () => [{ id: 1, url: t.url }],
      sendMessage: (_id, _msg, cb) => cb({ ok: true, data: t.read(t.url) }),
      onActivated: { addListener: (l) => t.listeners.activated.push(l) },
      onUpdated: { addListener: (l) => t.listeners.updated.push(l), removeListener: () => {} },
      reload: () => {},
    },
  };
`;

const verdictFor = (summary) => ({
  ok: true,
  data: {
    score: 70,
    verdict: "Good Deal",
    recommendation: "Buy",
    marketLow: 80,
    marketHigh: 120,
    suggestedOffer: 90,
    askingPrice: 100,
    savingsPercent: 0,
    summary,
    imagesAnalyzed: 1,
  },
});

let server, chrome, page;

const visibleState = () =>
  page.evaluate(`[...document.querySelectorAll('section[id^="state-"]')]
    .filter((s) => !s.classList.contains("hidden")).map((s) => s.id).join()`);
const text = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).textContent`);
const click = (id) => page.evaluate(`document.getElementById(${JSON.stringify(id)}).click()`);
const pendingCount = () => page.evaluate("window.__t.evaluations.length");
const release = (index, response) =>
  page.evaluate(`window.__t.evaluations[${index}].resolve(${JSON.stringify(response)}); new Promise((r) => setTimeout(r, 50))`);

async function waitFor(condition, label) {
  for (let i = 0; i < 100; i++) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for ${label}. Panel is showing: ${await visibleState()}`);
}

const waitForState = (name) => waitFor(async () => (await visibleState()) === `state-${name}`, name);

// A is on screen and being evaluated, with its answer not yet back.
async function startEvaluatingA() {
  await waitForState("ready");
  await click("btn-evaluate-now");
  await waitFor(async () => (await pendingCount()) === 1, "the evaluation request");
  assert.equal(await visibleState(), "state-evaluating");
}

const navigateTo = (url) => page.evaluate(`window.__t.navigate(${JSON.stringify(url)})`);

before(async () => {
  if (!CHROME) {
    if (IN_CI) throw new Error("Chrome not found in CI: the panel tests can't run.");
    return;
  }
  server = http
    .createServer((req, res) => {
      const file = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
      if (!file.startsWith(ROOT) || !fs.existsSync(file)) {
        res.statusCode = 404;
        return res.end();
      }
      res.setHeader("content-type", TYPES[path.extname(file)] ?? "text/plain");
      res.end(fs.readFileSync(file));
    })
    .listen(0);
  chrome = await launchChrome(CHROME);
  page = await chrome.newPage();
  await page.send("Page.addScriptToEvaluateOnNewDocument", { source: CHROME_STUB });
});

after(() => {
  chrome?.close();
  server?.close();
});

beforeEach(async () => {
  if (!CHROME) return;
  await page.navigate(`http://localhost:${server.address().port}/src/sidepanel/sidepanel.html`);
});

test("RACE: A's verdict arriving after moving to B never appears", opts, async () => {
  await startEvaluatingA();

  await navigateTo(URL_B);
  await waitFor(async () => (await visibleState()) !== "state-evaluating", "the move to B");

  await release(0, verdictFor("Verdict for A"));

  assert.ok(["state-reading", "state-ready"].includes(await visibleState()), await visibleState());
  assert.equal((await text("v-summary")).includes("Verdict for A"), false);

  await waitForState("ready");
  assert.equal(await text("ready-title"), "Fake Sofa B");
  assert.equal((await text("v-summary")).includes("Verdict for A"), false);
});

test("RACE: after discarding A's verdict, B can be evaluated and saved as B", opts, async () => {
  await startEvaluatingA();
  await navigateTo(URL_B);
  await waitForState("ready");
  await release(0, verdictFor("Verdict for A"));

  await click("btn-evaluate-now");
  await waitFor(async () => (await pendingCount()) === 2, "B's evaluation request");
  assert.equal(await page.evaluate("window.__t.evaluations[1].title"), "Fake Sofa B");

  await release(1, verdictFor("Verdict for B"));
  await waitForState("result");
  assert.equal(await text("v-title"), "Fake Sofa B");
  assert.equal(await text("v-summary"), "Verdict for B");

  await click("btn-save");
  await waitFor(() => page.evaluate("window.__t.saved.length === 1"), "the save");
  assert.deepEqual(await page.evaluate("[window.__t.saved[0].title, window.__t.saved[0].summary]"), [
    "Fake Sofa B",
    "Verdict for B",
  ]);
});

test("RACE: a late rejection or error for A doesn't replace B's screen", opts, async () => {
  for (const late of [{ ok: false, rejected: true, error: "Bad answer for A" }, { ok: false, error: "Failed for A" }]) {
    await page.navigate(`http://localhost:${server.address().port}/src/sidepanel/sidepanel.html`);
    await startEvaluatingA();
    await navigateTo(URL_B);
    await waitForState("ready");
    await release(0, late);
    assert.equal(await visibleState(), "state-ready");
  }
});

test("RACE: leaving Marketplace mid-evaluation shows the empty state, and stays there", opts, async () => {
  await startEvaluatingA();
  await navigateTo("https://www.facebook.com/");
  await waitForState("not_marketplace");
  await release(0, verdictFor("Verdict for A"));
  assert.equal(await visibleState(), "state-not_marketplace");
});

test("a shown result is cleared straight away on navigation, not after the preview delay", opts, async () => {
  await startEvaluatingA();
  await release(0, verdictFor("Verdict for A"));
  await waitForState("result");

  await navigateTo(URL_B);
  await waitForState("reading"); // the preview delay hasn't passed, so B isn't read yet
  await waitForState("ready");
  assert.equal(await text("ready-title"), "Fake Sofa B");
});

test("switching browser tabs to another listing clears the result too", opts, async () => {
  await startEvaluatingA();
  await release(0, verdictFor("Verdict for A"));
  await waitForState("result");

  await page.evaluate(`window.__t.url = ${JSON.stringify(URL_B)}; window.__t.listeners.activated.forEach((l) => l({}))`);
  await waitForState("ready");
  assert.equal(await text("ready-title"), "Fake Sofa B");
});

test("a navigation event for the same listing keeps its result on screen", opts, async () => {
  await startEvaluatingA();
  await release(0, verdictFor("Verdict for A"));
  await waitForState("result");
  await navigateTo(`${URL_A}?ref=other`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(await visibleState(), "state-result");
});

test("a double click on evaluate sends one request", opts, async () => {
  await waitForState("ready");
  await page.evaluate(`document.getElementById("btn-evaluate-now").click(); document.getElementById("btn-evaluate-now").click()`);
  await waitFor(async () => (await pendingCount()) >= 1, "the evaluation request");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(await pendingCount(), 1);
});

test("a refused read is logged with no listing content, and its reason appears in History", opts, async () => {
  await page.evaluate(`window.__t.read = (url) => ({
    url, verifiedItemId: null, verifiedBy: null, transitioning: false,
    title: "Fake Secret Title", price: "$123", description: "Fake secret description",
  })`);
  await navigateTo(URL_B);
  await waitForState("rejected");
  await waitFor(() => page.evaluate(`chrome.storage.local.get("gateRejections").then((r) => (r.gateRejections ?? []).length > 0)`), "the log");

  const [record] = await page.evaluate(`chrome.storage.local.get("gateRejections").then((r) => r.gateRejections)`);
  assert.deepEqual(Object.keys(record).sort(), ["at", "itemId", "reason", "verifiedBy"]);
  assert.equal(record.itemId, "1110002");
  assert.equal(JSON.stringify(record).includes("Fake Secret"), false);
  assert.equal(JSON.stringify(record).includes("123"), false);

  await click("tab-history");
  await waitFor(async () => (await text("history-rejections")).includes("confirm"), "the History line");
});

test("rejected and error show different messages", opts, async () => {
  await startEvaluatingA();
  await release(0, { ok: false, rejected: true, error: "Claude's answer was bad." });
  await waitForState("rejected");
  assert.equal(await text("rejected-title"), "Couldn't trust this evaluation");
  assert.match(await text("rejected-cost"), /billed/);

  await click("btn-reload");
  await page.navigate(`http://localhost:${server.address().port}/src/sidepanel/sidepanel.html`);
  await startEvaluatingA();
  await release(0, { ok: false, error: "Network down." });
  await waitForState("error");
  assert.equal(await text("error-message"), "Network down.");
});
