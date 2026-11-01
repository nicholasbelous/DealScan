// DealScan side panel — the primary UI.
//
// Flow: find the active Marketplace listing tab → ask its content script to
// scrape → normalize via parser. If the scrape isn't reliable, REFUSE here
// (show a notice, spend nothing). Otherwise hand off to the service worker,
// which fetches photos and runs the Claude evaluation, then render the verdict.
//
// What's on screen comes only from the state machine in panel-state.js, which
// also discards results for a listing the user has left.

import { checkRead, itemIdFromUrl } from "../shared/gate.js";
import { PANEL_STATES, initialPanelState, isBusy, panelReducer } from "../shared/panel-state.js";
import { parseListing } from "../shared/parser.js";
import { summarizeCost } from "../shared/stats.js";
import { toHistoryEntry } from "../shared/verdict.js";
import { categoryLabel, ALL_CATEGORIES } from "../shared/categories.js";
import {
  formatCost,
  formatMoney,
  formatRelative,
  noPhotosNotice,
  scoreColor,
  truncate,
} from "../shared/formatter.js";
import {
  getHistory,
  getUsageLog,
  addToHistory,
  removeFromHistory,
  isInHistory,
} from "../shared/storage.js";

const LISTING_URL_RE = /facebook\.com\/marketplace\/item\//;
const RING_CIRCUMFERENCE = 327; // 2πr, r=52 — matches the CSS dasharray
const VERIFIED_BY_LABELS = {
  panel_product_id: "Verified: listing panel",
  embedded_data: "Verified: page data",
};

const $ = (id) => document.getElementById(id);

let state = initialPanelState;

function dispatch(event) {
  state = panelReducer(state, event);
  render();
}

// ---------- Boot ----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  render();
  bindTabs();
  bindActions();
  populateCategoryFilter();
  routeInitialState();
});

// On open: auto-evaluate ONLY if the panel was opened by the page's "Evaluate
// Deal" button (which sets a one-shot flag). Opening via the toolbar icon just
// previews — never auto-spends.
async function routeInitialState() {
  const pending = await consumePendingEvaluate();
  const tab = await getListingTab();
  if (pending && tab && pending.tabId === tab.id) {
    evaluateActiveTab();
  } else {
    previewActiveTab();
  }
}

async function consumePendingEvaluate() {
  const { pendingEvaluate } = await chrome.storage.session.get("pendingEvaluate");
  if (pendingEvaluate) chrome.storage.session.remove("pendingEvaluate");
  if (!pendingEvaluate || Date.now() - pendingEvaluate.at > 10000) return null;
  return pendingEvaluate;
}

// Moving to another listing clears the old result at once, and any evaluation
// still running for it is discarded when it returns. The new listing is only
// PREVIEWED (free): passively browsing with the panel open must never spend money.
const PREVIEW_DELAY_MS = 1200; // Facebook is still swapping the page right after a click
let previewTimer = null;

async function syncToActiveTab() {
  const tab = await getListingTab();
  const itemId = tab ? itemIdFromUrl(tab.url) : null;
  if (itemId === state.itemId) return;

  dispatch({ type: "navigated", itemId });
  clearTimeout(previewTimer);
  if (itemId) previewTimer = setTimeout(() => previewActiveTab(), PREVIEW_DELAY_MS);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "LISTING_CHANGED") syncToActiveTab();
});
chrome.tabs.onActivated.addListener(() => syncToActiveTab());
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url) syncToActiveTab();
});

// ---------- Tabs -----------------------------------------------------------------

function bindTabs() {
  const tabs = [...document.querySelectorAll(".tab")];

  tabs.forEach((tab) => {
    tab.addEventListener("click", () => activateTab(tab));
    // Arrow-key navigation between tabs (WAI-ARIA tablist pattern).
    tab.addEventListener("keydown", (e) => {
      const i = tabs.indexOf(tab);
      let next = null;
      if (e.key === "ArrowRight" || e.key === "ArrowDown") next = tabs[(i + 1) % tabs.length];
      else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = tabs[(i - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) {
        e.preventDefault();
        activateTab(next);
        next.focus();
      }
    });
  });
}

function activateTab(tab) {
  document.querySelectorAll(".tab").forEach((t) => {
    const on = t === tab;
    t.classList.toggle("active", on);
    t.setAttribute("aria-selected", String(on));
    t.tabIndex = on ? 0 : -1;
  });
  document.querySelectorAll(".view").forEach((v) => {
    const on = v.id === `view-${tab.dataset.tab}`;
    v.classList.toggle("active", on);
    v.hidden = !on;
  });
  if (tab.dataset.tab === "history") renderHistory();
}

function bindActions() {
  $("btn-retry").addEventListener("click", () => evaluateActiveTab());
  $("btn-reload").addEventListener("click", () => reloadAndReread());
  $("btn-evaluate-now").addEventListener("click", () => evaluateActiveTab());
  $("btn-reevaluate").addEventListener("click", () => evaluateActiveTab({ force: true }));

  $("btn-save").addEventListener("click", async () => {
    if (state.name !== "result") return;
    await addToHistory(toHistoryEntry(state.listing, state.verdict)); // dedupes by URL — safe to click twice
    setSaved(true);
  });

  $("history-search").addEventListener("input", renderHistory);
  $("history-filter").addEventListener("change", renderHistory);
}

// Reflect whether the current listing is already in saved history, so the Save
// button reads "✓ Saved" instead of inviting a redundant (harmless) re-save.
function setSaved(saved) {
  const btn = $("btn-save");
  btn.textContent = saved ? "✓ Saved" : "💾 Save";
  btn.disabled = saved;
  btn.classList.toggle("is-saved", saved);
}

async function refreshSavedState(url) {
  setSaved(await isInHistory(url));
}

// ---------- Evaluate flow ----------------------------------------------------------

// Scrape the active listing and show it as "ready to evaluate" — no API call,
// no spend. Used on panel open (via icon) and on SPA navigation.
async function previewActiveTab() {
  if (state.name === "evaluating") return;
  await readActiveListing();
}

// Scrape + evaluate (spends API credit). Triggered only by explicit user
// action: the page's Evaluate button, the in-panel Evaluate button, or retry.
async function evaluateActiveTab({ force = false } = {}) {
  if (isBusy(state) && state.name !== "reading") return; // rapid clicks can't double-charge
  clearTimeout(previewTimer);

  const listing = await readActiveListing();
  if (!listing) return;

  dispatch({ type: "evaluate-started" });
  const { run } = state;
  try {
    const res = await chrome.runtime.sendMessage({
      type: "EVALUATE_LISTING",
      payload: listing,
      force,
    });
    if (res?.rejected) {
      dispatch({ type: "answer-rejected", run, reason: res.error });
    } else if (!res?.ok) {
      dispatch({ type: "evaluation-failed", run, message: res?.error ?? "Evaluation failed" });
    } else {
      dispatch({ type: "evaluated", run, verdict: res.data });
    }
  } catch (err) {
    dispatch({ type: "evaluation-failed", run, message: String(err.message ?? err) });
  }
}

// The reliability gate runs inside parseListing. Returns a listing only if it
// passed and the user is still on it.
async function readActiveListing() {
  const tab = await getListingTab();
  dispatch({ type: "navigated", itemId: tab ? itemIdFromUrl(tab.url) : null });
  if (!tab) return null;

  dispatch({ type: "read-started" });
  const { run } = state;
  try {
    const raw = await scrapeSettled(tab.id, run);
    if (state.run !== run) return null;
    dispatch({ type: "read-finished", run, listing: parseListing(raw) });
    return state.run === run && state.name === "ready" ? state.listing : null;
  } catch (err) {
    dispatch({ type: "read-failed", run, message: String(err.message ?? err) });
    return null;
  }
}

// Facebook loads listing data asynchronously after an in-app click, so the
// first read can be stale or mid-transition (this is why a refresh "fixed" it).
// Retry briefly until a read passes the gate. If none does, return the last
// read: parseListing runs the same gate on it, so the panel rejects it. Stops
// early if this read was superseded, so it doesn't keep polling a page.
const SCRAPE_ATTEMPTS = 6;
const SCRAPE_INTERVAL_MS = 450;
const RELOAD_TIMEOUT_MS = 15000;

async function scrapeSettled(tabId, run) {
  let raw = null;
  for (let i = 0; i < SCRAPE_ATTEMPTS && state.run === run; i++) {
    raw = await sendToTab(tabId, { type: "SCRAPE_LISTING" });
    if (checkRead(raw).reliable) return raw;
    if (i < SCRAPE_ATTEMPTS - 1) await sleep(SCRAPE_INTERVAL_MS);
  }
  return raw;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getListingTab() {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  return active && LISTING_URL_RE.test(active.url ?? "") ? active : null;
}

async function sendToTab(tabId, message) {
  try {
    return await sendMessageOnce(tabId, message);
  } catch (err) {
    if (!err.noReceiver) throw err;
    // Content scripts not present (tab predates the extension load). Inject
    // and retry.
    await chrome.scripting.executeScript({
      target: { tabId },
      files: chrome.runtime.getManifest().content_scripts[0].js,
    });
    return sendMessageOnce(tabId, message);
  }
}

function sendMessageOnce(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (res) => {
      if (chrome.runtime.lastError) {
        const err = new Error("Couldn't reach the page — try refreshing the listing tab.");
        err.noReceiver = true;
        reject(err);
      } else if (!res?.ok) {
        reject(new Error(res?.error ?? "Scrape failed"));
      } else {
        resolve(res.data);
      }
    });
  });
}

// Reload the listing and read it again. Stops at the preview: a retry after a
// rejection only re-reads, so it never spends API credit on its own.
async function reloadAndReread() {
  const tab = await getListingTab();
  if (!tab) {
    dispatch({ type: "navigated", itemId: null });
    return;
  }
  dispatch({ type: "read-started" });
  await reloadTab(tab.id);
  await previewActiveTab();
}

function reloadTab(tabId) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id, change) => {
      if (id === tabId && change.status === "complete") done();
    };
    const timer = setTimeout(done, RELOAD_TIMEOUT_MS);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.reload(tabId);
  });
}

// ---------- Rendering ---------------------------------------------------------------

const REJECTION_TEXT = {
  read: {
    title: "Couldn't read this listing",
    cost: "DealScan didn't evaluate it, so there's no charge.",
  },
  answer: {
    title: "Couldn't trust this evaluation",
    cost: "No result is shown, but the API attempts may still be billed.",
  },
};

// Everything on the Evaluate tab is drawn from `state`, and nothing else.
function render() {
  for (const name of PANEL_STATES) {
    $(`state-${name}`).classList.toggle("hidden", name !== state.name);
  }

  if (state.name === "ready") {
    $("ready-title").textContent = truncate(state.listing.title, 60);
  } else if (state.name === "evaluating") {
    $("evaluating-label").textContent = `Evaluating "${truncate(state.listing.title, 38)}"…`;
  } else if (state.name === "rejected") {
    const text = REJECTION_TEXT[state.rejection.kind];
    $("rejected-title").textContent = text.title;
    $("rejected-reason").textContent = state.rejection.reason;
    $("rejected-cost").textContent = text.cost;
  } else if (state.name === "error") {
    $("error-message").textContent = state.errorMessage;
  } else if (state.name === "result") {
    renderVerdict(state.listing, state.verdict);
    refreshSavedState(state.listing.url);
  }
}

// ---------- Verdict rendering --------------------------------------------------------

function renderVerdict(listing, v) {
  $("v-title").textContent = listing.title;
  $("v-category").textContent = categoryLabel(listing.category);

  const photos = v.imagesAnalyzed ?? 0;
  $("v-photos").textContent = photos > 0 ? `👁️ ${photos} photo${photos === 1 ? "" : "s"}` : "";
  $("v-photos").classList.toggle("hidden", photos === 0);
  $("v-cached").classList.toggle("hidden", !v.fromCache);
  $("v-verified").textContent = VERIFIED_BY_LABELS[listing.verifiedBy] ?? "";

  // Score ring
  const score = v.score;
  const color = scoreColor(score);
  const ring = $("ring-fill");
  ring.style.stroke = color;
  ring.style.strokeDashoffset =
    score == null ? RING_CIRCUMFERENCE : RING_CIRCUMFERENCE * (1 - score / 100);
  $("ring-score").textContent = score ?? "–";

  $("v-verdict").textContent = v.verdict ?? "—";
  $("v-verdict").style.color = color;
  $("v-recommendation").textContent = v.recommendation ?? "—";
  $("v-summary").textContent = v.summary ?? "";

  const notice = noPhotosNotice(v, listing.verifiedBy);
  $("v-no-photos").textContent = notice ?? "";
  $("v-no-photos").classList.toggle("hidden", !notice);

  $("score-ring").setAttribute(
    "aria-label",
    score == null
      ? "Deal score unavailable"
      : `Deal score ${score} out of 100 — ${v.verdict ?? ""}`.trim()
  );

  // Prices. A genuine $0 asking is a free giveaway — show "Free" rather than
  // "$0" so the panel doesn't look broken.
  const cur = listing.currency;
  const isFree = v.askingPrice === 0;
  $("p-asking").textContent = isFree ? "Free" : formatMoney(v.askingPrice ?? listing.price, cur);
  $("p-market").textContent =
    v.marketLow != null && v.marketHigh != null && v.marketHigh > 0
      ? `${formatMoney(v.marketLow, cur)}–${formatMoney(v.marketHigh, cur)}`
      : "—";
  $("p-offer").textContent = isFree ? "Free" : formatMoney(v.suggestedOffer, cur);

  const savings = Number(v.savingsPercent);
  const savingsEl = $("p-savings");
  if (Number.isFinite(savings)) {
    const below = savings >= 0;
    savingsEl.textContent = `${Math.abs(Math.round(savings))}% ${below ? "below" : "above"}`;
    savingsEl.style.color = below ? "var(--great)" : "var(--avoid)";
  } else {
    savingsEl.textContent = "—";
    savingsEl.style.color = "";
  }
}

// ---------- History tab ---------------------------------------------------------------

function populateCategoryFilter() {
  const select = $("history-filter");
  for (const cat of ALL_CATEGORIES) {
    const opt = document.createElement("option");
    opt.value = cat;
    opt.textContent = categoryLabel(cat);
    select.appendChild(opt);
  }
}

async function renderCostSummary() {
  const summary = summarizeCost(await getUsageLog());
  $("history-cost").classList.toggle("hidden", !summary);
  if (!summary) return;
  $("history-cost").textContent =
    `Measured cost over ${summary.count} evaluation${summary.count === 1 ? "" : "s"}: ` +
    `median ${formatCost(summary.median)}, p90 ${formatCost(summary.p90)}, ` +
    `total ${formatCost(summary.total)}. Includes retries and rejected answers.`;
}

async function renderHistory() {
  renderCostSummary();
  const all = await getHistory();
  const query = $("history-search").value.trim().toLowerCase();
  const category = $("history-filter").value;

  const filtered = all.filter(
    (h) =>
      (!category || h.category === category) &&
      (!query || h.title?.toLowerCase().includes(query))
  );

  renderCardList($("history-list"), $("history-empty"), filtered, (entry) =>
    removeFromHistory(entry.id).then(renderHistory)
  );
}

// Renders the saved-history list.
function renderCardList(listEl, emptyEl, entries, onRemove) {
  listEl.replaceChildren();
  emptyEl.classList.toggle("hidden", entries.length > 0);

  for (const entry of entries) {
    const li = document.createElement("li");

    const row = document.createElement("div");
    row.className = "card-row";

    const left = document.createElement("div");
    const title = document.createElement("p");
    title.className = "card-title";
    const link = document.createElement("a");
    link.href = entry.url ?? "#";
    link.target = "_blank";
    link.rel = "noopener";
    link.textContent = truncate(entry.title ?? "(untitled)", 55);
    title.appendChild(link);

    const sub = document.createElement("p");
    sub.className = "card-sub";
    sub.textContent = [
      formatMoney(entry.price, entry.currency ?? "$"),
      entry.verdict,
      categoryLabel(entry.category),
      formatRelative(entry.savedAt),
      Number.isFinite(entry.evaluation?.costUsd) ? formatCost(entry.evaluation.costUsd) : null,
    ]
      .filter(Boolean)
      .join(" · ");

    left.append(title, sub);

    const score = document.createElement("span");
    score.className = "card-score";
    score.textContent = entry.score ?? "–";
    score.style.color = scoreColor(entry.score);

    row.append(left, score);

    const actions = document.createElement("div");
    actions.className = "card-actions";
    const removeBtn = document.createElement("button");
    removeBtn.textContent = "Remove";
    removeBtn.addEventListener("click", () => onRemove(entry));
    actions.appendChild(removeBtn);

    li.append(row, actions);
    listEl.appendChild(li);
  }
}
