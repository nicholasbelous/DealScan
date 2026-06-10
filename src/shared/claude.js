// Anthropic API wrapper for DealScan.
//
// Called only from the service worker (background) — never from content
// scripts or the page. The API key lives in chrome.storage.local and is read
// here at call time; it never touches the page context.
//
// This talks to the Anthropic Messages API over plain fetch (no SDK — this is
// a vanilla MV3 extension). Web search is enabled so Claude can pull real
// market pricing for the listing. The model returns a structured JSON verdict
// that the side panel renders.

import { getSettings } from "./storage.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

// Default model. Override per-user via the Options page (stored in settings).
// NOTE: cost scales a lot with this choice — see the eval-cost table in the
// README. Sonnet/Haiku are far cheaper than Opus for this workload.
const DEFAULT_MODEL = "claude-sonnet-4-6";

// Server-side web search tool — lets Claude look up real market prices.
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 5 };

// JSON shape we ask Claude to return. Kept in one place so the prompt and the
// parser/renderer stay in sync.
const VERDICT_SCHEMA = `{
  "score": number,                       // 0-100 deal score
  "verdict": string,                     // "Great Deal" | "Good Deal" | "Fair" | "Overpriced" | "Avoid"
  "recommendation": string,              // "Buy" | "Negotiate" | "Pass"
  "askingPrice": number,
  "marketLow": number,                   // low end of used market range
  "marketHigh": number,                  // high end of used market range
  "retailNew": number,                   // approx price new, or null
  "suggestedOffer": number,              // what the buyer should offer
  "savingsPercent": number,              // % below (positive) or above (negative) market
  "demand": string,                      // "high" | "medium" | "low"
  "redFlags": string[],
  "greenFlags": string[],
  "negotiationTips": string[],
  "summary": string                      // one or two sentence headline
}`;

const SYSTEM_PROMPT = `You are DealScan, an expert at evaluating Facebook Marketplace listings.

You receive a scraped listing (title, price, condition, description, seller info).
Use web search to find real current market prices for the item — check completed
sales, retail prices, and comparable used listings.

Then return your evaluation as a SINGLE JSON object matching this exact shape,
with no prose before or after it:

${VERDICT_SCHEMA}

Scoring guidance:
- 85-100 Great Deal, 70-84 Good Deal, 50-69 Fair, 30-49 Overpriced, 0-29 Avoid.
- Weigh asking price against the used market range, condition, and demand.
- redFlags: scam signals, stock photos, vague descriptions, suspiciously low prices.
- greenFlags: original packaging, receipts, motivated seller, detailed description.
- Category-aware: cars -> mileage/year; electronics -> model generation; furniture -> brand tier.
- Return numbers as plain numbers (no "$" or commas). Use null for unknown numeric fields.`;

/**
 * Evaluate a scraped listing. Returns the parsed verdict object.
 * @param {object} listing - normalized listing from the parser.
 * @returns {Promise<object>} parsed verdict matching VERDICT_SCHEMA.
 */
export async function evaluateListing(listing) {
  const { anthropicKey, model } = await getSettings();
  if (!anthropicKey) {
    throw new Error("No Anthropic API key set. Add one in the extension Options.");
  }

  const messages = [
    { role: "user", content: buildUserPrompt(listing) },
  ];

  // Web search runs a server-side loop; if it pauses (stop_reason
  // "pause_turn") we re-send to let it continue. Cap the continuations.
  let response = await callMessages({ apiKey: anthropicKey, model, messages });

  for (let i = 0; i < 5 && response.stop_reason === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: response.content });
    response = await callMessages({ apiKey: anthropicKey, model, messages });
  }

  return parseVerdict(response);
}

// --- Internals ---------------------------------------------------------------

function buildUserPrompt(listing) {
  // The parser hands us a clean object; serialize the fields Claude needs.
  const lines = [
    `Title: ${listing.title ?? "(unknown)"}`,
    `Category: ${listing.category ?? "other"}`,
    `Asking price: ${listing.priceRaw ?? listing.price ?? "(unknown)"}`,
    `Condition: ${listing.condition ?? "(not stated)"}`,
    `Location: ${listing.location ?? "(not stated)"}`,
    `Seller: ${listing.seller ?? "(not stated)"}`,
    "",
    "Description:",
    listing.description ?? "(none)",
  ];
  if (listing.images?.length) {
    lines.push("", `Image count: ${listing.images.length}`);
  }
  return lines.join("\n");
}

async function callMessages({ apiKey, model, messages }) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": API_VERSION,
      // Required for calls made directly from a browser/extension context.
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model: model || DEFAULT_MODEL,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: [WEB_SEARCH_TOOL],
      messages,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Anthropic API ${res.status}: ${body || res.statusText}`);
  }
  return res.json();
}

function parseVerdict(response) {
  // Pull the text blocks (web search adds non-text blocks we ignore) and
  // extract the JSON object Claude returned.
  const text = (response.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) {
    throw new Error("Could not find a JSON verdict in Claude's response.");
  }
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    throw new Error(`Failed to parse verdict JSON: ${err.message}`);
  }
}
