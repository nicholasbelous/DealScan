// POST /v1/evaluate: the server's trust boundary.
//
// The listing arrives already verified by the extension. The body schema refuses
// any field it doesn't name, so seller data can't get in even by mistake. The
// model's answer goes through the same validation as direct mode, and everything
// billed is recorded, whatever the outcome. Identical content is answered from
// the cache, which costs nothing and so isn't subject to the budget.

import { DEFAULT_MODEL, runEvaluation } from "../../../src/shared/anthropic.js";
import { contentHash } from "../../../src/shared/cache-key.js";
import { MODEL_PRICES, emptyUsage } from "../../../src/shared/pricing.js";
import { PROMPT_VERSION } from "../../../src/shared/prompt.js";
import { VerdictRejectedError } from "../../../src/shared/verdict.js";
import { findCachedVerdict, recordEvaluation, rememberListing, spentToday } from "../store.js";

const nullableString = (maxLength) => ({ type: ["string", "null"], maxLength });

const bodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["listing"],
  properties: {
    model: { type: "string", enum: Object.keys(MODEL_PRICES) },
    images: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["media_type", "data"],
        properties: {
          media_type: { type: "string", enum: ["image/jpeg", "image/png", "image/webp", "image/gif"] },
          data: { type: "string", maxLength: 6_000_000 },
        },
      },
    },
    listing: {
      type: "object",
      additionalProperties: false,
      required: ["itemId", "title", "price"],
      properties: {
        itemId: { type: "string", pattern: "^[0-9]+$", maxLength: 40 },
        title: { type: "string", minLength: 1, maxLength: 500 },
        price: { type: "number", minimum: 0 },
        priceRaw: nullableString(50),
        currency: nullableString(5),
        condition: nullableString(200),
        category: nullableString(50),
        description: nullableString(5000),
        location: nullableString(200),
        attributes: {
          type: ["object", "null"],
          additionalProperties: false,
          properties: { year: { type: "string" }, mileage: { type: "string" } },
        },
      },
    },
  },
};

// What a cache hit cost: nothing, so nothing reached the API.
const freeEvaluation = ({ model, promptVersion }) => ({
  model,
  promptVersion,
  ...emptyUsage(),
  attempts: 0,
  latencyMs: 0,
  costUsd: 0,
});

export function registerEvaluateRoute(app, { db, config, now }) {
  app.post("/v1/evaluate", { schema: { body: bodySchema } }, async (req, reply) => {
    const { listing, images = [], model = DEFAULT_MODEL } = req.body;
    const at = now();
    const hash = await contentHash(listing, images);
    const base = {
      tokenId: req.user.id,
      itemId: listing.itemId,
      contentHash: hash,
      model,
      promptVersion: PROMPT_VERSION,
    };

    rememberListing(db, listing.itemId, hash, listing, at);

    const cached = findCachedVerdict(db, base, at - config.cacheTtlMs);
    if (cached) {
      const verdict = { ...cached, fromCache: true, evaluation: freeEvaluation(base) };
      recordEvaluation(db, { ...base, status: "valid", verdict, evaluation: verdict.evaluation, cacheHit: true, now: at });
      return { status: "valid", verdict };
    }

    if (spentToday(db, at) >= config.dailyBudgetUsd) {
      recordEvaluation(db, { ...base, status: "error", reason: "budget_exceeded", now: at });
      return reply.code(429).send({
        status: "error",
        code: "budget_exceeded",
        reason: "The server's daily budget has been reached. Try again tomorrow.",
      });
    }

    try {
      const verdict = await runEvaluation({ apiKey: config.anthropicKey, model }, listing, images);
      recordEvaluation(db, { ...base, status: "valid", verdict, evaluation: verdict.evaluation, now: now() });
      return { status: "valid", verdict };
    } catch (err) {
      const rejected = err instanceof VerdictRejectedError;
      const reason = rejected ? err.message : "upstream_error";
      recordEvaluation(db, {
        ...base,
        status: rejected ? "rejected" : "error",
        reason,
        evaluation: err.evaluation,
        now: now(),
      });
      if (rejected) {
        return reply.code(422).send({
          status: "rejected",
          code: "invalid_model_output",
          reason,
          evaluation: err.evaluation,
        });
      }
      req.log.error({ errorName: err.name }, "evaluation failed");
      return reply.code(502).send({
        status: "error",
        code: "upstream_error",
        reason: "The server couldn't reach Claude. Try again.",
        evaluation: err.evaluation,
      });
    }
  });
}
