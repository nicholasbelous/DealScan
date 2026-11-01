// The Fastify app. Built separately from index.js so tests can run it in memory.

import Fastify from "fastify";

import { registerEvaluateRoute } from "./routes/evaluate.js";
import { latestEvaluation } from "./store.js";
import { findToken } from "./tokens.js";

const BODY_LIMIT_BYTES = 20 * 1024 * 1024; // three base64 photos plus the listing

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
    const code = err.validation ? "invalid_request" : status === 413 ? "too_large" : "server_error";
    return reply.code(status).send({ status: "error", code, reason: status >= 500 ? "Server error." : err.message });
  });

  app.get("/healthz", async () => ({ status: "ok" }));

  // Everything else needs a valid token, checked before the body is parsed.
  app.register(async (authed) => {
    authed.addHook("onRequest", async (req, reply) => {
      const token = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1];
      req.user = token ? findToken(db, token) : null;
      if (!req.user) {
        return reply.code(401).send({ status: "error", code: "unauthorized", reason: "Missing or invalid token." });
      }
    });

    registerEvaluateRoute(authed, { db, config, now });

    authed.get("/v1/evaluations/:itemId", async (req, reply) => {
      const row = latestEvaluation(db, req.params.itemId);
      if (!row) return reply.code(404).send({ status: "error", code: "not_found", reason: "No evaluation for that item." });
      return row;
    });
  });

  return app;
}
