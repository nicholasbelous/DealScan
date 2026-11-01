-- The evaluate route looks up a fresh, valid, non-cached answer on every request.
CREATE INDEX evaluations_cache_lookup
  ON evaluations (item_id, content_hash, model, prompt_version, created_at)
  WHERE status = 'valid' AND cache_hit = 0;
