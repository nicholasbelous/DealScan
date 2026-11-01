// Create a per-user token: npm run token:create -- <name>
// Prints it once. Only a hash is stored.

import { openDb } from "../src/db.js";
import { createToken } from "../src/tokens.js";

const name = process.argv[2];
if (!name) {
  console.error("Usage: npm run token:create -- <name>");
  process.exit(1);
}

const db = openDb(process.env.DB_PATH || "data/dealscan.db");
console.log(createToken(db, name));
