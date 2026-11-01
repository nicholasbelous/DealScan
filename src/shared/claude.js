// Anthropic API wrapper for DealScan.
//
// Called only from the service worker (background) — never from content
// scripts or the page. The API key lives in chrome.storage.local and is read
// here at call time; it never touches the page context.
//
// Plain fetch (no SDK — vanilla MV3 extension). Two cost-controlled modes:
//   - default: Claude estimates market price from its own knowledge (cheap)
//   - opt-in:  one web search for current prices (Options → Use web search)
// Listing photos (2-3) are sent as images so Claude can judge condition and
// catch stock-photo scams. Output is trimmed to bare essentials to keep both
// tokens and the UI lean.

import { getSettings } from "./storage.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const DEFAULT_MODEL = "claude-haiku-4-5";
const EFFORT_MODELS = /sonnet-4-6|opus-4/; // only these accept output_config.effort
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 2 };
const REQUEST_TIMEOUT_MS = 90_000;

// Bare-essentials verdict — score, verdict, prices, suggested offer, summary.
// No flag lists (deliberately trimmed for a clean panel + cheaper output).
const VERDICT_SCHEMA = `{
  "score": number,            // 0-100 deal score
  "verdict": string,          // "Great Deal" | "Good Deal" | "Fair" | "Overpriced" | "Avoid"
  "recommendation": string,   // "Buy" | "Negotiate" | "Pass"
  "askingPrice": number,
  "marketLow": number,        // low end of used market range
  "marketHigh": number,       // high end of used market range
  "suggestedOffer": number,   // what the buyer should offer
  "savingsPercent": number,   // ASKING price vs market midpoint: positive = asking is BELOW market (a deal), negative = asking is ABOVE market (overpriced). NOT the offer.
  "summary": string           // ONE concise sentence; mention any deal-breaker
}`;

const PROMPT_INTRO = `You are DealScan, an expert at evaluating Facebook Marketplace listings.

You receive a scraped listing (title, price, condition, description), and
usually some of its photos. The photos are pulled automatically by a scraper
and can occasionally be missing, low-resolution, or fail to transfer — that is
a limitation of OUR tooling, never evidence about the seller.

Photo rules:
- If the photos clearly show the item: use them to judge real condition.
- Our scraper can occasionally attach an image from ELSEWHERE on the page — an
  ad, a banner, or stock scenery (e.g. a car ad, lab chemicals, a landscape).
  If some photos match the item and others are clearly unrelated, the unrelated
  ones are scraping noise: IGNORE them and judge from the photos that match plus
  the text. Never call the listing a scam or mismatched because of a stray image
  that obviously belongs to page furniture rather than the listing.
- Flag a scam ONLY on confident positive evidence that the LISTING'S OWN photos
  are fake — a professional studio/catalog shot or watermark used as the item
  photo. When in doubt, do not accuse.
- If photos are missing, blurry, generic, or unhelpful: silently ignore them
  and evaluate from the text alone. Do NOT lower the score, do NOT call it a
  scam, and do NOT mention photo quality in the summary.
- Always produce a full evaluation with a score and suggestedOffer based on
  the price and description — never refuse to evaluate.

Free listings: if the asking price is 0 (a giveaway), still estimate the item's
normal used-market worth for marketLow/marketHigh, set suggestedOffer to 0, and
score it as a strong deal — a free, usable item is worth grabbing — unless the
photos or description show it is broken, incomplete, or a scam.

For vehicles: mileage and year drive value more than anything else. Use the
"Key details" line (parsed mileage/year) and anything in the description. If
mileage is genuinely not provided anywhere, price for typical mileage for that
year and note in the summary that the estimate assumes typical mileage because
none was listed — do not pretend a number you weren't given.`;

const PRICING_FROM_KNOWLEDGE = `
Estimate the item's current used-market price range from your knowledge of
resale values, brand tiers, and depreciation. Used-goods prices move slowly —
your knowledge is sufficient. Widen marketLow/marketHigh when less certain.`;

const PRICING_FROM_SEARCH = `
Run ONE targeted web search for the item's current used price (e.g. "<item>
used price"). Only search again if the first result is unusable. Searches are
expensive — never browse exploratively.`;

const PROMPT_RULES = `
Return your evaluation as a SINGLE JSON object matching this exact shape, with
no prose before or after it:

${VERDICT_SCHEMA}

Scoring: 85-100 Great Deal, 70-84 Good Deal, 50-69 Fair, 30-49 Overpriced,
0-29 Avoid. Weigh asking price vs the used market range and the condition you
see in the photos.

savingsPercent compares the ASKING price to the midpoint of marketLow/marketHigh
— compute (midpoint - asking) / midpoint * 100. It must NOT be based on the
suggested offer.

Internal consistency is REQUIRED — score, verdict, savingsPercent, and summary
must all agree:
- If askingPrice is at or above marketHigh, the asking is OVERPRICED:
  savingsPercent must be negative, verdict is "Overpriced" or "Avoid", score
  below 50, and the summary must NOT call the price "competitive", "fair", or
  "a good deal". Say it is above market and to negotiate down.
- Only call pricing competitive/good when askingPrice is at or below the
  market midpoint (savingsPercent positive).
- suggestedOffer is the negotiation target and is independent of savingsPercent.

Keep "summary" to one sentence. Return numbers plain (no "$" or commas); use
null for genuinely unknown numeric fields.`;

/**
 * Evaluate a scraped listing.
 * @param {object} listing - normalized, reliable listing from the parser.
 * @param {Array<{media_type:string,data:string}>} [images] - base64 photos.
 * @returns {Promise<object>} parsed verdict matching VERDICT_SCHEMA.
 */
export async function evaluateListing(listing, images = []) {
  const { anthropicKey, model, useWebSearch } = await getSettings();
  if (!anthropicKey) {
    throw new Error("No Anthropic API key set. Add one in the extension Options.");
  }

  const messages = [{ role: "user", content: buildUserContent(listing, images) }];
  const opts = { apiKey: anthropicKey, model, useWebSearch };

  let response = await callMessages({ ...opts, messages });

  // Only web search produces server-side pause_turn continuations.
  if (useWebSearch) {
    for (let i = 0; i < 2 && response.stop_reason === "pause_turn"; i++) {
      messages.push({ role: "assistant", content: response.content });
      response = await callMessages({ ...opts, messages });
    }
  }

  return finalizeVerdict(parseVerdict(response), listing);
}

// Make the verdict trustworthy and self-consistent — never rely on the model
// for arithmetic or for keeping its own fields in agreement:
//   • asking price comes from the actual scrape, not the model's echo
//   • savingsPercent is computed in code (asking vs market midpoint)
//   • the rating label is derived from the score, so they can't contradict
//   • all numerics are coerced/clamped; an inverted market range is corrected
export function finalizeVerdict(v, listing) {
  const num = (x) => {
    const n = Number(x);
    return Number.isFinite(n) ? n : null;
  };

  v.score = clampScore(num(v.score));
  v.marketLow = num(v.marketLow);
  v.marketHigh = num(v.marketHigh);
  v.suggestedOffer = num(v.suggestedOffer);

  // The asking price is known from the scrape — authoritative over the model.
  v.askingPrice = listing.price ?? num(v.askingPrice);

  // Correct an inverted market range.
  if (v.marketLow != null && v.marketHigh != null && v.marketLow > v.marketHigh) {
    [v.marketLow, v.marketHigh] = [v.marketHigh, v.marketLow];
  }

  // Derive savingsPercent ourselves: asking vs market midpoint. Positive =
  // below market (a deal), negative = above (overpriced).
  if (v.askingPrice != null && v.marketLow != null && v.marketHigh != null) {
    const mid = (v.marketLow + v.marketHigh) / 2;
    v.savingsPercent = mid > 0 ? Math.round(((mid - v.askingPrice) / mid) * 100) : num(v.savingsPercent);
  } else {
    v.savingsPercent = num(v.savingsPercent);
  }

  // A suggested offer above the asking price makes no sense.
  if (v.suggestedOffer != null && v.askingPrice != null && v.suggestedOffer > v.askingPrice) {
    v.suggestedOffer = v.askingPrice;
  }

  // Keep the rating label in lockstep with the score.
  if (v.score != null) v.verdict = verdictForScore(v.score);

  return v;
}

const VERDICT_BANDS = [
  [85, "Great Deal"],
  [70, "Good Deal"],
  [50, "Fair"],
  [30, "Overpriced"],
  [0, "Avoid"],
];

function verdictForScore(score) {
  for (const [min, label] of VERDICT_BANDS) {
    if (score >= min) return label;
  }
  return "Avoid";
}

function clampScore(n) {
  return n == null ? null : Math.max(0, Math.min(100, Math.round(n)));
}

// --- Internals ---------------------------------------------------------------

function buildUserContent(listing, images) {
  const content = [];

  // Images first so Claude grounds its read of the text in what it sees.
  for (const img of images) {
    content.push({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    });
  }

  content.push({ type: "text", text: buildListingText(listing, images.length) });
  return content;
}

function buildListingText(listing, imageCount) {
  const attrs =
    listing.attributes && Object.keys(listing.attributes).length > 0
      ? Object.entries(listing.attributes)
          .map(([k, v]) => `${k}: ${v}`)
          .join(", ")
      : null;

  const lines = [
    `Title: ${listing.title ?? "(unknown)"}`,
    `Category: ${listing.category ?? "other"}`,
    `Asking price: ${listing.priceRaw ?? listing.price ?? "(unknown)"}`,
    `Condition (seller-stated): ${listing.condition ?? "(not stated)"}`,
    `Key details: ${attrs ?? "(none parsed)"}`,
    `Location: ${listing.location ?? "(not stated)"}`,
    "",
    "Description:",
    (listing.description ?? "(none)").slice(0, 1500),
    "",
    imageCount > 0
      ? `${imageCount} listing photo(s) are attached above.`
      : "No photos were available for this listing.",
  ];
  return lines.join("\n");
}

// Transient failures worth retrying: rate limits, server errors, and
// Anthropic's "overloaded" (529). A timeout (AbortError) is NOT retried.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 2;

async function callMessages({ apiKey, model, messages, useWebSearch }) {
  const resolvedModel = model || DEFAULT_MODEL;
  const body = {
    model: resolvedModel,
    max_tokens: 700,
    system:
      PROMPT_INTRO +
      (useWebSearch ? PRICING_FROM_SEARCH : PRICING_FROM_KNOWLEDGE) +
      PROMPT_RULES,
    messages,
  };
  if (useWebSearch) {
    body.tools = [WEB_SEARCH_TOOL];
    body.cache_control = { type: "ephemeral" };
  }
  if (EFFORT_MODELS.test(resolvedModel)) {
    body.output_config = { effort: "medium" };
  }
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let res = null;
    let networkErr = null;
    try {
      res = await fetch(API_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": API_VERSION,
          "anthropic-dangerous-direct-browser-access": "true",
        },
        body: payload,
      });
    } catch (err) {
      networkErr = err;
    } finally {
      clearTimeout(timer);
    }

    if (networkErr) {
      if (networkErr.name === "AbortError") {
        throw new Error("Evaluation timed out after 90s — try again.");
      }
      if (attempt < MAX_RETRIES) {
        await sleep(backoffMs(attempt));
        continue;
      }
      throw new Error("Couldn't reach Anthropic — check your connection and retry.");
    }

    if (res.ok) return res.json();

    const text = await res.text().catch(() => "");
    if (RETRYABLE_STATUS.has(res.status) && attempt < MAX_RETRIES) {
      await sleep(retryDelayMs(attempt, res.headers));
      continue;
    }
    throw new Error(`Anthropic API ${res.status}: ${friendlyApiError(res.status, text)}`);
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoffMs = (attempt) => 1000 * 2 ** attempt; // 1s, 2s

function retryDelayMs(attempt, headers) {
  const retryAfter = Number(headers?.get?.("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) {
    return Math.min(retryAfter * 1000, 10000);
  }
  return backoffMs(attempt);
}

function friendlyApiError(status, body) {
  if (status === 401) return "invalid API key — check it in Options.";
  if (status === 429) return "rate limited — wait a moment and retry.";
  if (status === 400 && /credit balance/i.test(body)) {
    return "out of API credit — top up at console.anthropic.com.";
  }
  return body || "request failed.";
}

function parseVerdict(response) {
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
