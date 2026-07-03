// DealScan side panel — the primary UI.
//
// Flow: find the active Marketplace listing tab → ask its content script to
// scrape → normalize via parser. If the scrape isn't reliable, REFUSE here
// (show a notice, spend nothing). Otherwise hand off to the service worker,
// which fetches photos and runs the Claude evaluation, then render the verdict.

import { parseListing } from "../shared/parser.js";
import { categoryLabel, ALL_CATEGORIES } from "../shared/categories.js";
import {
  formatMoney,
  formatRelative,
  scoreColor,
  truncate,
} from "../shared/formatter.js";
import {
  getHistory,
  addToHistory,
  removeFromHistory,
  isInHistory,
} from "../shared/storage.js";

const LISTING_URL_RE = /facebook\.com\/marketplace\/item\//;
const RING_CIRCUMFERENCE = 327; // 2πr, r=52 — matches the CSS dasharray

const $ = (id) => document.getElementById(id);

// What the Save button acts on.
let current = { listing: null, verdict: null };

// ---------- Boot ----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
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

// SPA navigation to another listing: PREVIEW it (free), don't auto-evaluate.
// Passively browsing listings with the panel open must never spend money.
let navDebounce = null;
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "LISTING_CHANGED") return;
  clearTimeout(navDebounce);
  navDebounce = setTimeout(() => previewActiveTab(), 1200);
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
  $("btn-reload").addEventListener("click", () => evaluateActiveTab());
  $("btn-evaluate-now").addEventListener("click", () => evaluateActiveTab());
  $("btn-reevaluate").addEventListener("click", () => evaluateActiveTab({ force: true }));

  $("btn-save").addEventListener("click", async () => {
    if (!current.verdict) return;
    await addToHistory(historyEntry()); // dedupes by URL — safe to click twice
    setSaved(true);
  });

  $("history-search").addEventListener("input", renderHistory);
  $("history-filter").addEventListener("change", renderHistory);
}

function historyEntry() {
  const { listing, verdict } = current;
  return {
    url: listing.url,
    title: listing.title,
    category: listing.category,
    price: listing.price,
    currency: listing.currency,
    score: verdict.score,
    verdict: verdict.verdict,
    recommendation: verdict.recommendation,
    suggestedOffer: verdict.suggestedOffer,
    summary: verdict.summary,
  };
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
  const tab = await getListingTab();
  if (!tab) {
    showState("idle");
    return;
  }
  try {
    const listing = await scrapeActiveListing(tab.id);
    if (!listing.reliable) {
      showState("unreliable");
      return;
    }
    $("ready-title").textContent = truncate(listing.title, 60);
    showState("ready");
  } catch {
    showState("idle");
  }
}

// Scrape + evaluate (spends API credit). Triggered only by explicit user
// action: the page's Evaluate button, the in-panel Evaluate button, or retry.
let evaluating = false;
async function evaluateActiveTab({ force = false } = {}) {
  if (evaluating) return; // guard against rapid clicks double-charging
  evaluating = true;

  try {
    const tab = await getListingTab();
    if (!tab) {
      showState("idle");
      return;
    }

    showState("loading", "Reading listing…");
    const listing = await scrapeActiveListing(tab.id);

    // The reliability gate. Refuse rather than evaluate possibly-wrong data.
    if (!listing.reliable) {
      showState("unreliable");
      return;
    }

    showState("loading", `Evaluating "${truncate(listing.title, 38)}"…`);
    const res = await chrome.runtime.sendMessage({
      type: "EVALUATE_LISTING",
      payload: listing,
      force,
    });
    if (!res?.ok) throw new Error(res?.error ?? "Evaluation failed");

    current.verdict = res.data;
    renderVerdict(listing, res.data);
    showState("verdict");
    refreshSavedState(listing.url);
  } catch (err) {
    $("error-message").textContent = String(err.message ?? err);
    showState("error");
  } finally {
    evaluating = false;
  }
}

async function scrapeActiveListing(tabId) {
  const raw = await scrapeSettled(tabId);
  const listing = parseListing(raw);
  current = { listing, verdict: null };
  return listing;
}

// Facebook loads listing data asynchronously after an in-app click, so the
// first read can be stale or mid-transition (this is why a refresh "fixed" it).
// Accept immediately when an item-id-verified source is present (the refresh
// case); otherwise retry briefly until two consecutive DOM-only reads agree and
// the page is no longer mid-swap. Settles fast in practice; refuses (rather
// than misfires) only if the page never stabilizes.
const SCRAPE_ATTEMPTS = 6;
const SCRAPE_INTERVAL_MS = 450;

async function scrapeSettled(tabId) {
  let prev = null;
  for (let i = 0; i < SCRAPE_ATTEMPTS; i++) {
    const raw = await sendToTab(tabId, { type: "SCRAPE_LISTING" });
    if (raw.verified) return raw; // pinned to the URL's item id — trust now
    const stable =
      raw.confidence === "high" &&
      !raw.transitioning &&
      prev &&
      prev.title === raw.title &&
      prev.price === raw.price;
    if (stable) return raw;
    prev = raw;
    if (i < SCRAPE_ATTEMPTS - 1) await sleep(SCRAPE_INTERVAL_MS);
  }
  return prev; // best effort — the parser's reliability gate handles the rest
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
      files: [
        "src/content/scraper.js",
        "src/content/injector.js",
        "src/content/observer.js",
      ],
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

function showState(name, loadingLabel) {
  ["idle", "loading", "ready", "unreliable", "error", "verdict"].forEach((s) =>
    $(`state-${s}`).classList.toggle("hidden", s !== name)
  );
  if (loadingLabel) $("loading-label").textContent = loadingLabel;
}

// ---------- Verdict rendering --------------------------------------------------------

function renderVerdict(listing, v) {
  $("v-title").textContent = listing.title;
  $("v-category").textContent = categoryLabel(listing.category);

  const photos = v.imagesAnalyzed ?? 0;
  $("v-photos").textContent = photos > 0 ? `👁️ ${photos} photo${photos === 1 ? "" : "s"}` : "";
  $("v-photos").classList.toggle("hidden", photos === 0);
  $("v-cached").classList.toggle("hidden", !v.fromCache);

  // Score ring
  const score = clampScore(v.score);
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

function clampScore(score) {
  const n = Number(score);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
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

async function renderHistory() {
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
