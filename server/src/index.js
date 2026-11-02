// Starts the server: configuration from env vars, the SQLite database (migrated
// on open), then the app on HOST:PORT.

import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import { openDb } from "./db.js";

const config = loadConfig();
const db = openDb(config.dbPath);
// Fastify's default request log has no headers or bodies, so no tokens or listings.
const app = buildApp({ db, config, logger: true });

await app.listen({ host: config.host, port: config.port });
