// Identifies what was evaluated, for the server's cache. A changed price,
// description, or photo is a different hash. Uses Web Crypto, which Node and
// browsers both have. Direct mode doesn't use it: the service worker's cache is
// keyed by listing URL.

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
