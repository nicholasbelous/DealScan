// DealScan service worker — the extension's background brain.
//
// Responsibilities:
//   1. Open the side panel when the toolbar icon is clicked.
//   2. Route messages between content scripts (page) and the side panel (UI).
//   3. Run privileged work that content scripts/UI cannot: Claude API calls,
//      eBay lookups. API keys never touch the page — they live here + storage.
//
// Content scripts and the side panel talk to this worker via chrome.runtime
// messages. This file is the single choke point for anything that needs an
// API key or cross-context coordination.

import { evaluateListing } from "../shared/claude.js";

// --- Toolbar icon → open the side panel --------------------------------------
// With no popup defined, clicking the action opens the side panel directly.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.windowId != null) {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  }
});

// Allow the side panel to open from the action icon on supported Chrome builds.
chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch(() => {
      /* older Chrome without setPanelBehavior — onClicked handler covers it */
    });
});

// --- Message router ----------------------------------------------------------
// Messages are { type, payload }. Async handlers return true to keep the
// sendResponse channel open until the promise settles.
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  switch (message?.type) {
    case "EVALUATE_LISTING":
      handleEvaluate(message.payload)
        .then((result) => sendResponse({ ok: true, data: result }))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
      return true; // keep channel open for the async response

    case "PING":
      sendResponse({ ok: true, data: "pong" });
      return false;

    default:
      sendResponse({ ok: false, error: `Unknown message type: ${message?.type}` });
      return false;
  }
});

// --- Handlers ----------------------------------------------------------------
async function handleEvaluate(listing) {
  if (!listing) throw new Error("No listing data provided");
  return evaluateListing(listing);
}
