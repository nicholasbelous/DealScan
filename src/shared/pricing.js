// What an evaluation cost, from the API's reported usage and Anthropic's prices.
// To update: copy from PRICING_SOURCE and change PRICING_AS_OF. Pure logic.

export const PRICING_AS_OF = "2026-11-01";
export const PRICING_SOURCE = "https://platform.claude.com/docs/en/about-claude/pricing";

// USD per million tokens. cacheWrite is the 5-minute rate, which is what
// cache_control: { type: "ephemeral" } uses.
export const MODEL_PRICES = {
  "claude-haiku-4-5": { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  "claude-sonnet-4-6": { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  "claude-opus-4-8": { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
};

// $10 per 1,000 searches.
export const WEB_SEARCH_USD = 0.01;

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, webSearches: 0 };
}

/** Add one Messages API `usage` object to a running total. */
export function addUsage(total, usage = {}) {
  return {
    inputTokens: total.inputTokens + (usage.input_tokens ?? 0),
    outputTokens: total.outputTokens + (usage.output_tokens ?? 0),
    cacheWriteTokens: total.cacheWriteTokens + (usage.cache_creation_input_tokens ?? 0),
    cacheReadTokens: total.cacheReadTokens + (usage.cache_read_input_tokens ?? 0),
    webSearches: total.webSearches + (usage.server_tool_use?.web_search_requests ?? 0),
  };
}

/** @returns {number|null} USD, or null for a model not in the table: never a guess. */
export function costUsd(model, usage) {
  const prices = MODEL_PRICES[model];
  if (!prices) return null;
  const perMillion =
    usage.inputTokens * prices.input +
    usage.outputTokens * prices.output +
    usage.cacheWriteTokens * prices.cacheWrite +
    usage.cacheReadTokens * prices.cacheRead;
  return perMillion / 1_000_000 + usage.webSearches * WEB_SEARCH_USD;
}
