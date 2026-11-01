// The Fastify app. Built separately from index.js so tests can run it in memory.

import fs from "node:fs";

import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";

import { registerEvaluateRoute } from "./routes/evaluate.js";
import { STATS_WINDOWS, buildStats, windowStart } from "./stats.js";
import { evaluationsSince, latestEvaluation } from "./store.js";
import { findToken } from "./tokens.js";

const BODY_LIMIT_BYTES = 20 * 1024 * 1024; // three base64 photos plus the listing

// The stats page: static files with no data in them. Scripts come only from this
// server, and the page can only talk back to it.
const STATS_PAGE_FILES = {
  "/stats": ["stats.html", "text/html; charset=utf-8"],
  "/stats.js": ["stats.js", "text/javascript; charset=utf-8"],
  "/stats.css": ["stats.css", "text/css; charset=utf-8"],
};
const STATS_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'none'";

export function buildApp({ db, config, logger = false, now = Date.now }) {
  const app = Fastify({
    logger,
    bodyLimit: BODY_LIMIT_BYTES,
    // Reject unknown fields and wrong types instead of quietly fixing them.
    ajv: { customOptions: { removeAdditional: false, coerceTypes: false, allErrors: false } },
  });

  app.setErrorHandler((err, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error({ errorName: err.name }, "request failed");
    if (status === 429) {
      return reply.code(429).send({ status: "error", code: "rate_limited", reason: "Too many requests. Wait a minute and retry." });
    }
    const code = err.validation ? "invalid_request" : status === 413 ? "too_large" : "server_error";
    return reply.code(status).send({ status: "error", code, reason: status >= 500 ? "Server error." : err.message });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  for (const [url, [file, type]] of Object.entries(STATS_PAGE_FILES)) {
    const content = fs.readFileSync(new URL(`../public/${file}`, import.meta.url));
    app.get(url, (_req, reply) => reply.type(type).header("content-security-policy", STATS_PAGE_CSP).send(content));
  }

  // Everything else needs a valid token, checked before the body is parsed.
  app.register(async (authed) => {
    authed.addHook("onRequest", async (req, reply) => {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      req.user = token ? findToken(db, token) : null;
      if (!req.user) {
        return reply.code(401).send({ status: "error", code: "unauthorized", reason: "Missing or invalid token." });
      }
    });

    // Per token, and after auth, so it runs once req.user is known.
    await authed.register(rateLimit, {
      max: config.rateLimitPerMinute,
      timeWindow: 60_000,
      hook: "preParsing",
      keyGenerator: (req) => `token:${req.user.id}`,
    });

    registerEvaluateRoute(authed, { db, config, now });

    const statsQuery = {
      type: "object",
      additionalProperties: false,
      properties: { window: { type: "string", enum: STATS_WINDOWS } },
    };
    authed.get("/v1/stats", { schema: { querystring: statsQuery } }, async (req) => {
      const window = req.query.window ?? "7d";
      return { window, ...buildStats(evaluationsSince(db, windowStart(window, now()))) };
    });

    authed.get("/v1/evaluations/:itemId", async (req, reply) => {
      const row = latestEvaluation(db, req.params.itemId);
      if (!row) return reply.code(404).send({ status: "error", code: "not_found", reason: "No evaluation for that item." });
      return row;
    });
  });

  return app;
}
