// Server configuration and database migrations.

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { loadConfig } from "../src/config.js";
import { migrate, openDb } from "../src/db.js";

test("refuses to start without a key or a valid budget", () => {
  assert.throws(() => loadConfig({ DAILY_BUDGET_USD: "1" }), /ANTHROPIC_API_KEY/);
  for (const budget of [undefined, "", "0", "-1", "lots"]) {
    assert.throws(() => loadConfig({ ANTHROPIC_API_KEY: "k", DAILY_BUDGET_USD: budget }), /DAILY_BUDGET_USD/);
  }
});

test("reads the budget from env and binds to localhost by default", () => {
  const config = loadConfig({ ANTHROPIC_API_KEY: "k", DAILY_BUDGET_USD: "2.5" });
  assert.equal(config.dailyBudgetUsd, 2.5);
  assert.equal(config.host, "127.0.0.1");
});

test("migrations apply in numeric order, once each", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealscan-migrations-"));
  fs.writeFileSync(path.join(dir, "002_b.sql"), "ALTER TABLE t ADD COLUMN b TEXT;");
  fs.writeFileSync(path.join(dir, "001_a.sql"), "CREATE TABLE t (a TEXT);");
  fs.writeFileSync(path.join(dir, "notes.txt"), "not a migration");

  const db = openDb(":memory:");
  assert.deepEqual(migrate(db, dir), ["001_a.sql", "002_b.sql"]);
  assert.deepEqual(migrate(db, dir), []);
  assert.deepEqual(db.pragma("table_info(t)").map((c) => c.name), ["a", "b"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a failed migration leaves nothing behind", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dealscan-migrations-"));
  fs.writeFileSync(path.join(dir, "001_bad.sql"), "CREATE TABLE half (a TEXT); NOT SQL;");
  const db = openDb(":memory:");
  assert.throws(() => migrate(db, dir));
  assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 'half'").get(), undefined);
  fs.rmSync(dir, { recursive: true, force: true });
});
