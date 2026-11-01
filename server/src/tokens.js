// Per-user API tokens. Only a hash is stored, so the database can't leak them.

import { createHash, randomBytes } from "node:crypto";

const hashToken = (token) => createHash("sha256").update(token).digest("hex");

/** @returns {string} the new token. It can't be recovered later. */
export function createToken(db, name, now = Date.now()) {
  const token = `dst_${randomBytes(32).toString("base64url")}`;
  db.prepare("INSERT INTO tokens (name, token_hash, created_at) VALUES (?, ?, ?)").run(name, hashToken(token), now);
  return token;
}

/** @returns {{id: number, name: string}|null} the active token's owner. */
export function findToken(db, token) {
  return (
    db
      .prepare("SELECT id, name FROM tokens WHERE token_hash = ? AND revoked_at IS NULL")
      .get(hashToken(token)) ?? null
  );
}

export function revokeToken(db, id, now = Date.now()) {
  db.prepare("UPDATE tokens SET revoked_at = ? WHERE id = ?").run(now, id);
}
