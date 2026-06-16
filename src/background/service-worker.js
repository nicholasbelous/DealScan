// DealScan service worker — the extension's background brain.
//
// Responsibilities:
//   1. Open the side panel (toolbar icon, or the floating page button).
//   2. Route messages between content scripts (page) and the side panel (UI).
//   3. Privileged work the page/UI can't do: fetch listing images cross-origin
//      (the background context bypasses CORS for declared hosts) and call the
//      Claude API. API keys never touch the page.
//   4. Cache verdicts per listing URL so re-opening doesn't re-spend credit.

import { evaluateListing } from "../shared/claude.js";
import { getSettings } from "../shared/storage.js";

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_IMAGES = 3;
const MAX_IMAGE_BYTES = 4_000_000;
// Reject tiny files: avatars, icons, and blurred preview thumbs are a few KB,
// real listing photos are ~50KB+. Sending placeholders to Claude reads as
// "fake listing" and produces false scam verdicts.
const MIN_IMAGE_BYTES = 10_000;
const IMAGE_FETCH_TIMEOUT_MS = 8000;
const SUPPORTED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// --- Side panel opening --------------------------------------------------------

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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "OPEN_SIDE_PANEL":
      // From the floating button. Must run synchronously off the user gesture.
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
        .catch((err) => sendResponse({ ok: false, error: String(err.message ?? err) }));
      return true;

    case "PING":
      sendResponse({ ok: true, data: "pong" });
      return false;

    default:
      // LISTING_CHANGED etc. are consumed by the side panel directly.
      return false;
  }
});

// --- Evaluation + cache ----------------------------------------------------------

async function handleEvaluate(listing, force) {
  if (!listing) throw new Error("No listing data provided");
  // Belt-and-suspenders: the panel already gates on this, but never evaluate
  // an unreliable scrape here either.
  if (listing.reliable === false) {
    throw new Error("Listing data could not be read reliably.");
  }

  const cacheKey = listing.url ? `verdict:${listing.url}` : null;
  if (cacheKey && !force) {
    const cached = await readCache(cacheKey);
    if (cached) return { ...cached, fromCache: true };
  }

  const { analyzeImages } = await getSettings();
  const images =
    analyzeImages && Array.isArray(listing.images) && listing.images.length > 0
      ? await fetchImages(listing.images)
      : [];

  const verdict = await evaluateListing(listing, images);
  verdict.imagesAnalyzed = images.length;

  if (cacheKey) await writeCache(cacheKey, verdict);
  return verdict;
}

// --- Image fetching (background bypasses CORS for *.fbcdn.net) -----------------

async function fetchImages(urls) {
  const out = [];
  for (const url of urls.slice(0, MAX_IMAGES)) {
    const img = await fetchOneImage(url);
    if (img) out.push(img);
  }
  return out;
}

async function fetchOneImage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return null;

    const mediaType = normalizeImageType(res.headers.get("content-type"));
    if (!mediaType) return null;

    const buffer = await res.arrayBuffer();
    if (buffer.byteLength < MIN_IMAGE_BYTES || buffer.byteLength > MAX_IMAGE_BYTES) return null;

    return { media_type: mediaType, data: arrayBufferToBase64(buffer) };
  } catch {
    return null; // images are best-effort; never block the evaluation
  } finally {
    clearTimeout(timer);
  }
}

function normalizeImageType(contentType) {
  if (!contentType) return "image/jpeg"; // fbcdn usually serves jpeg
  const type = contentType.split(";")[0].trim().toLowerCase();
  return SUPPORTED_IMAGE_TYPES.has(type) ? type : null;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000; // build the binary string in chunks to avoid arg limits
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return self.btoa(binary);
}

// --- Verdict cache (session storage: in-memory, cleared when browser closes) ----

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
