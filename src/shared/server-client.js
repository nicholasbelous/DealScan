// Server mode: the extension calls a DealScan server with a token, and the
// Anthropic key stays on the server. Called only from the service worker.

import { VerdictRejectedError } from "./verdict.js";

const TIMEOUT_MS = 180_000; // the server may retry an invalid answer

/** The only fields that leave the extension in server mode. */
function toServerListing(listing) {
  return {
    itemId: listing.itemId,
    title: listing.title,
    price: listing.price,
    priceRaw: listing.priceRaw,
    currency: listing.currency,
    condition: listing.condition,
    category: listing.category,
    description: listing.description?.slice(0, 5000) ?? null,
    location: listing.location,
    attributes: listing.attributes,
  };
}

/**
 * Evaluate through the server. Same contract as direct mode.
 * @throws {VerdictRejectedError} if the server rejected the model's answer.
 */
export async function evaluateViaServer({ serverUrl, serverToken, model }, listing, images = []) {
  if (!serverUrl || !serverToken) {
    throw new Error("Server mode needs a server URL and token. Add them in the extension Options.");
  }

  let res;
  try {
    res = await fetch(`${serverUrl.replace(/\/+$/, "")}/v1/evaluate`, {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "content-type": "application/json", authorization: `Bearer ${serverToken}` },
      body: JSON.stringify({ model, listing: toServerListing(listing), images }),
    });
  } catch {
    throw new Error("Couldn't reach the DealScan server. Check the URL in Options and retry.");
  }

  const body = await res.json().catch(() => ({}));
  if (res.ok && body.status === "valid") return body.verdict;

  const err =
    res.status === 422
      ? new VerdictRejectedError(body.reason ?? "The server rejected Claude's answer.")
      : new Error(serverErrorMessage(res.status, body));
  err.evaluation = body.evaluation;
  throw err;
}

function serverErrorMessage(status, body) {
  if (status === 401) return "The server refused this token. Check it in Options.";
  return body.reason ?? `The DealScan server returned an error (${status}).`;
}
