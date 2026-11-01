// Identifies what was evaluated. A changed price, description, or photo is a
// different hash. Uses Web Crypto, so it runs in the extension and on the server.

async function sha256(text) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const normalize = (value) =>
  typeof value === "string" ? value.replace(/\s+/g, " ").trim().toLowerCase() : value ?? null;

/** Hash of a listing's normalized content, including its photos. */
export async function contentHash(listing, images = []) {
  const attributes = Object.entries(listing.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
  return sha256(
    JSON.stringify([
      normalize(listing.title),
      listing.price,
      normalize(listing.condition),
      normalize(listing.category),
      normalize(listing.description),
      normalize(listing.location),
      attributes,
      images.map((image) => image.data),
    ])
  );
}
