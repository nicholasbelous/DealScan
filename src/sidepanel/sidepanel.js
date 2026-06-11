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
  formatPercent,
  formatRelative,
  scoreColor,
  truncate,
} from "../shared/formatter.js";
import {
  getHistory,
  addToHistory,
  removeFromHistory,
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
} from "../shared/storage.js";

const LISTING_URL_RE = /facebook\.com\/marketplace\/item\//;
const RING_CIRCUMFERENCE = 327; // 2πr, r=52 — matches the CSS dasharray

const $ = (id) => document.getElementById(id);

// What the Save / Watchlist buttons act on.
let current = { listing: null, verdict: null };

// ---------- Boot ----------------------------------------------------------------

document.addEventListener("DOMContentLoaded", () => {
  bindTabs();
  bindActions();
  populateCategoryFilter();
  evaluateActiveTab();
});

// Re-evaluate when Facebook SPA-navigates to another listing while we're open.
let navDebounce = null;
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type !== "LISTING_CHANGED") return;
  clearTimeout(navDebounce);
  navDebounce = setTimeout(() => evaluateActiveTab(), 1200);
});

// ---------- Tabs -----------------------------------------------------------------

function bindTabs() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      tab.classList.add("active");
      $(`view-${tab.dataset.tab}`).classList.add("active");
      if (tab.dataset.tab === "history") renderHistory();
      if (tab.dataset.tab === "watchlist") renderWatchlist();
    });
  });
}

function bindActions() {
  $("btn-retry").addEventListener("click", () => evaluateActiveTab());
  $("btn-reload").addEventListener("click", () => evaluateActiveTab());
  $("btn-reevaluate").addEventListener("click", () => evaluateActiveTab({ force: true }));

  $("btn-save").addEventListener("click", async () => {
    if (!current.verdict) return;
    await addToHistory(historyEntry());
    flashButton($("btn-save"), "✓ Saved");
  });

  $("btn-watch").addEventListener("click", async () => {
    if (!current.verdict) return;
    await addToWatchlist(historyEntry());
    flashButton($("btn-watch"), "✓ Watching");
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

function flashButton(btn, label) {
  const original = btn.textContent;
  btn.textContent = label;
  btn.disabled = true;
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1600);
}

// ---------- Evaluate flow ----------------------------------------------------------

async function evaluateActiveTab({ force = false } = {}) {
  const tab = await getListingTab();
  if (!tab) {
    showState("idle");
    return;
  }

  try {
    showState("loading", "Reading listing…");
    const raw = await sendToTab(tab.id, { type: "SCRAPE_LISTING" });
    const listing = parseListing(raw);
    current = { listing, verdict: null };

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
  } catch (err) {
    $("error-message").textContent = String(err.message ?? err);
    showState("error");
  }
}

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
  ["idle", "loading", "unreliable", "error", "verdict"].forEach((s) =>
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

  // Prices
  const cur = listing.currency;
  $("p-asking").textContent = formatMoney(v.askingPrice ?? listing.price, cur);
  $("p-market").textContent =
    v.marketLow != null && v.marketHigh != null
      ? `${formatMoney(v.marketLow, cur)}–${formatMoney(v.marketHigh, cur)}`
      : "—";
  $("p-offer").textContent = formatMoney(v.suggestedOffer, cur);

  const savings = v.savingsPercent;
  const savingsEl = $("p-savings");
  if (savings != null && Number.isFinite(Number(savings))) {
    const below = Number(savings) >= 0;
    savingsEl.textContent = `${formatPercent(Math.abs(savings)).replace("+", "")} ${below ? "below" : "above"}`;
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

// ---------- Watchlist tab ---------------------------------------------------------------

async function renderWatchlist() {
  const all = await getWatchlist();
  renderCardList($("watchlist-list"), $("watchlist-empty"), all, (entry) =>
    removeFromWatchlist(entry.id).then(renderWatchlist)
  );
}

// Shared card renderer for both lists.
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
      formatRelative(entry.savedAt ?? entry.addedAt),
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
