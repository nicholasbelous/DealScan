// SQLite setup. Migrations are plain numbered SQL files, applied on startup.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import Database from "better-sqlite3";

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations", import.meta.url));

export function openDb(dbPath) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db, dir = MIGRATIONS_DIR) {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)");
  const applied = new Set(db.prepare("SELECT name FROM schema_migrations").all().map((m) => m.name));
  const pending = fs
    .readdirSync(dir)
    .filter((file) => /^\d+_.*\.sql$/.test(file) && !applied.has(file))
    .sort();

  for (const file of pending) {
    db.transaction(() => {
      db.exec(fs.readFileSync(path.join(dir, file), "utf8"));
      db.prepare("INSERT INTO schema_migrations VALUES (?, ?)").run(file, Date.now());
    })();
  }
  return pending;
}
