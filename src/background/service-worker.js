// DealScan service worker — the extension's background brain.
//
// Responsibilities:
//   1. Open the side panel (toolbar icon click, or the floating page button).
//   2. Route messages between content scripts (page) and the side panel (UI).
//   3. Run privileged work that content scripts/UI cannot: Claude API calls.
//      API keys never touch the page — they live here + storage.
//   4. Cache verdicts per listing URL so re-opening the panel on the same
//      listing doesn't re-spend API credit.
//
// Content scripts and the side panel talk to this worker via chrome.runtime
// messages. This file is the single choke point for anything that needs an
// API key or cross-context coordination.

import { evaluateListing } from "../shared/claude.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

// --- Side panel opening --------------------------------------------------------

// Toolbar icon click → open the panel (also covered by setPanelBehavior below,
// but kept as a fallback for older Chrome builds).
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* older Chrome without setPanelBehavior — onClicked handler covers it */
    });
});

// --- Message router ------------------------------------------------------------
// Messages are { type, payload }. Async handlers return true to keep the
// sendResponse channel open until the promise settles.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "OPEN_SIDE_PANEL":
      // From the floating button. Must run synchronously off the user gesture,
      // so no awaits before the open() call.
      if (sender.tab?.windowId != null) {
        chrome.sidePanel
          .open({ windowId: sender.tab.windowId })
          .then(() => sendResponse({ ok: true }))
          .catch((err) => sendResponse({ ok: false, error: String(err) }));
        return true;
      }
      sendResponse({ ok: false, error: "No window to open the panel in" });
      return false;

    case "EVALUATE_LISTING":
      handleEvaluate(message.payload, message.force === true)
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true;

    case "PING":
      sendResponse({ ok: true, data: "pong" });
      return false;

    default:
      // LISTING_CHANGED and other broadcast messages are consumed by the side
      // panel directly; the worker ignores them without erroring.
      return false;
  }
});

// --- Evaluation + cache ----------------------------------------------------------

async function handleEvaluate(listing, force) {
  if (!listing) throw new Error("No listing data provided");

  const cacheKey = listing.url ? `verdict:${listing.url}` : null;

  if (cacheKey && !force) {
    const cached = await readCache(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  }

  const verdict = await evaluateListing(listing);

  if (cacheKey) {
    await writeCache(cacheKey, verdict);
  }
  return verdict;
}

// chrome.storage.session: in-memory, survives service-worker restarts, cleared
// when the browser closes — exactly the lifetime we want for a price cache.
async function readCache(key) {
  const res = await chrome.storage.session.get(key);
  const entry = res[key];
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    chrome.storage.session.remove(key);
    return null;
  }
  return entry.verdict;
}

async function writeCache(key, verdict) {
  await chrome.storage.session.set({ [key]: { verdict, at: Date.now() } });
}
