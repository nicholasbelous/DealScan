// Direct mode: the extension calls Anthropic with the user's own key.
//
// Called only from the service worker (background) — never from content
// scripts or the page. The API key lives in chrome.storage.local and is read
// here at call time; it never touches the page context.

import { runEvaluation } from "./anthropic.js";
import { getSettings } from "./storage.js";

/** See runEvaluation for the result and thrown errors. */
export async function evaluateListing(listing, images = []) {
  const { anthropicKey, model, useWebSearch } = await getSettings();
  if (!anthropicKey) {
    throw new Error("No Anthropic API key set. Add one in the extension Options.");
  }
  const headers = { "anthropic-dangerous-direct-browser-access": "true" };
  return runEvaluation({ apiKey: anthropicKey, model, useWebSearch, headers }, listing, images);
}
