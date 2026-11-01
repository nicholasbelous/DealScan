// Server configuration, from env vars only. Refuses to start without a key or a
// budget cap, so the server can't run with unlimited spending by accident.

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function loadConfig(env = process.env) {
  const anthropicKey = env.ANTHROPIC_API_KEY;
  if (!anthropicKey) throw new Error("ANTHROPIC_API_KEY is required.");

  const dailyBudgetUsd = Number(env.DAILY_BUDGET_USD);
  if (!env.DAILY_BUDGET_USD || !Number.isFinite(dailyBudgetUsd) || dailyBudgetUsd <= 0) {
    throw new Error("DAILY_BUDGET_USD is required and must be a positive number.");
  }

  return {
    anthropicKey,
    dailyBudgetUsd,
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT) || 3000,
    dbPath: env.DB_PATH || "data/dealscan.db",
    cacheTtlMs: positiveNumber(env.CACHE_TTL_SECONDS, 3600) * 1000,
    rateLimitPerMinute: positiveNumber(env.RATE_LIMIT_PER_MINUTE, 30),
  };
}
