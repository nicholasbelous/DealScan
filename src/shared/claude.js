// Anthropic API client for DealScan.
//
// Called only from the service worker (background) — never from content
// scripts or the page. The API key lives in chrome.storage.local and is read
// here at call time; it never touches the page context.
//
// Plain fetch (no SDK — vanilla MV3 extension). Two cost-controlled modes:
//   - default: Claude estimates market price from its own knowledge (cheap)
//   - opt-in:  one web search for current prices (Options → Use web search)
// An answer that fails validation gets one retry, then the listing is rejected.

import { addUsage, costUsd, emptyUsage } from "./pricing.js";
import { PROMPT_VERSION, buildSystemPrompt, buildUserContent } from "./prompt.js";
import { getSettings } from "./storage.js";
import {
  VERDICT_JSON_SCHEMA,
  VerdictRejectedError,
  finalizeVerdict,
  readVerdict,
} from "./verdict.js";

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

const DEFAULT_MODEL = "claude-haiku-4-5";
const EFFORT_MODELS = /sonnet-4-6|opus-4/; // only these accept output_config.effort
const WEB_SEARCH_TOOL = { type: "web_search_20260209", name: "web_search", max_uses: 2 };
const REQUEST_TIMEOUT_MS = 90_000;
const MAX_TOKENS = 700;
const MAX_EVALUATION_ATTEMPTS = 2; // the first try plus one retry on invalid output

/**
 * Evaluate a scraped listing.
 * @param {object} listing - normalized, reliable listing from the parser.
 * @param {Array<{media_type:string,data:string}>} [images] - base64 photos.
 * @returns {Promise<object>} a validated, finalized verdict, with an `evaluation`
 *   record of what it took: model, prompt version, tokens, latency, and cost.
 * @throws {VerdictRejectedError} if no valid answer came back.
 */
export async function evaluateListing(listing, images = []) {
  const { anthropicKey, model: chosenModel, useWebSearch } = await getSettings();
  if (!anthropicKey) {
    throw new Error("No Anthropic API key set. Add one in the extension Options.");
  }
  const model = chosenModel || DEFAULT_MODEL;
  const content = buildUserContent(listing, images);
  const startedAt = Date.now();

  let usage = emptyUsage();
  let result;
  for (let attempt = 1; attempt <= MAX_EVALUATION_ATTEMPTS; attempt++) {
    const opts = { apiKey: anthropicKey, model, useWebSearch, maxTokens: MAX_TOKENS * attempt };
    const turn = await runTurn(opts, content, usage);
    usage = turn.usage;

    result = readVerdict(turn.response, listing);
    if (result.ok) {
      const evaluation = {
        model,
        promptVersion: PROMPT_VERSION,
        ...usage,
        attempts: attempt,
        latencyMs: Date.now() - startedAt,
        costUsd: costUsd(model, usage),
      };
      return { ...finalizeVerdict(result.verdict, listing), evaluation };
    }
    if (!result.retryable) break;
  }
  throw new VerdictRejectedError(result.reason);
}

// One evaluation attempt. Only web search produces server-side pause_turn
// continuations. A retry gets more max_tokens, since a cut-off answer can't
// pass validation.
async function runTurn(opts, content, usageSoFar) {
  const messages = [{ role: "user", content }];

  let response = await callMessages({ ...opts, messages });
  let usage = addUsage(usageSoFar, response.usage);
  for (let i = 0; opts.useWebSearch && i < 2 && response.stop_reason === "pause_turn"; i++) {
    messages.push({ role: "assistant", content: response.content });
    response = await callMessages({ ...opts, messages });
    usage = addUsage(usage, response.usage);
  }
  return { response, usage };
}

// Transient failures worth retrying: rate limits, server errors, and
// Anthropic's "overloaded" (529). A timeout (AbortError) is NOT retried.
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 529]);
const MAX_RETRIES = 2;

async function callMessages({ apiKey, model, messages, useWebSearch, maxTokens }) {
  const body = {
    model,
    max_tokens: maxTokens,
    system: buildSystemPrompt(useWebSearch),
    messages,
  };
  const outputConfig = {};
  if (useWebSearch) {
    body.tools = [WEB_SEARCH_TOOL];
    body.cache_control = { type: "ephemeral" };
  } else {
    // Not with web search: search results carry citations, and the docs list
    // citations as incompatible with a JSON format. Code validates both modes.
    outputConfig.format = { type: "json_schema", schema: VERDICT_JSON_SCHEMA };
  }
  if (EFFORT_MODELS.test(model)) outputConfig.effort = "medium";
  if (Object.keys(outputConfig).length > 0) body.output_config = outputConfig;
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
