// All reads and writes for listings and evaluations.

export function rememberListing(db, itemId, contentHash, listing, now) {
  db.prepare(
    `INSERT OR IGNORE INTO listings
       (item_id, content_hash, title, price, condition, category, description, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    itemId,
    contentHash,
    listing.title,
    listing.price,
    listing.condition ?? null,
    listing.category ?? null,
    listing.description ?? null,
    now
  );
}

export function recordEvaluation(db, row) {
  const verdict = row.verdict ?? {};
  const usage = row.evaluation ?? {};
  db.prepare(
    `INSERT INTO evaluations
       (token_id, item_id, content_hash, model, prompt_version, status, rejection_reason,
        score, verdict, price_low, price_high, suggested_offer, raw_response,
        input_tokens, output_tokens, attempts, cost_usd, latency_ms, cache_hit, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.tokenId,
    row.itemId,
    row.contentHash,
    row.model,
    row.promptVersion,
    row.status,
    row.reason ?? null,
    verdict.score ?? null,
    verdict.verdict ?? null,
    verdict.marketLow ?? null,
    verdict.marketHigh ?? null,
    verdict.suggestedOffer ?? null,
    row.verdict ? JSON.stringify(row.verdict) : null,
    usage.inputTokens ?? 0,
    usage.outputTokens ?? 0,
    usage.attempts ?? 0,
    usage.costUsd ?? null,
    usage.latencyMs ?? null,
    row.cacheHit ? 1 : 0,
    row.now
  );
}

/** USD spent since the start of the current UTC day, across all tokens. */
export function spentToday(db, now) {
  const dayStart = new Date(now).setUTCHours(0, 0, 0, 0);
  return db
    .prepare("SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM evaluations WHERE created_at >= ?")
    .get(dayStart).spent;
}

export function latestEvaluation(db, itemId) {
  return (
    db
      .prepare(
        `SELECT item_id, model, prompt_version, status, rejection_reason, score, verdict,
                price_low, price_high, suggested_offer, cost_usd, latency_ms, cache_hit, created_at
         FROM evaluations WHERE item_id = ? ORDER BY created_at DESC, id DESC LIMIT 1`
      )
      .get(itemId) ?? null
  );
}
