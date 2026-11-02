// Pure checks on sanitized HTML. If any of these finds something, the sanitizer
// writes nothing. A second, independent line of defense after the default-deny pass.

export const FIXTURE_SECRET_PATTERNS = [
  ["session token name", /fb_dtsg|c_user|\bxs=|datr|lsd=|jazoest|__user|accessToken|access_token/i],
  ["email address", /[\w.+-]+@[\w-]+\.[\w.]+/],
  ["API key", /sk-ant-/],
  ["event handler or inline style", /\s(on[a-z]+|style|data-[\w-]+|class|id)=["']/i],
];

/**
 * @param {string} html - sanitized output.
 * @param {string[]} originals - every value the sanitizer replaced.
 * @returns {string[]} problems. Empty means clean. Names the kind, not the value,
 *   so a leak isn't repeated into a terminal log or a test failure.
 */
export function findLeaks(html, originals, { itemPrefix, profilePrefix, photoHost }) {
  const problems = [];

  // Very short originals match by accident ("a", "12"), and Fake words are ours.
  const tooShort = (value) => value.length < 4;
  const leaked = originals.filter((value) => !tooShort(value) && html.includes(value));
  if (leaked.length > 0) problems.push(`${leaked.length} replaced value(s) still appear in the output`);

  for (const [name, pattern] of FIXTURE_SECRET_PATTERNS) {
    if (pattern.test(html)) problems.push(`Contains a ${name}`);
  }

  const longNumbers = html.match(/\d{6,}/g) ?? [];
  const realLooking = longNumbers.filter((n) => !n.startsWith(itemPrefix) && !n.startsWith(profilePrefix));
  if (realLooking.length > 0) problems.push(`${realLooking.length} long number(s) that aren't fake IDs`);

  const hosts = [...html.matchAll(/https?:\/\/([^/"'\s<>]+)/g)].map((m) => m[1]);
  const unknownHosts = hosts.filter((host) => host !== photoHost);
  if (unknownHosts.length > 0) problems.push(`${unknownHosts.length} URL(s) on a host other than the fake photo host`);

  const scripts = html.match(/<script\b[^>]*>/g) ?? [];
  if (scripts.some((tag) => !/type="application\/json"/.test(tag)) || scripts.length > 1) {
    problems.push("Contains a script other than the rebuilt listing data");
  }

  return problems;
}

/** Drop what could navigate or redirect the page before it's even parsed. */
export function preStrip(html) {
  return html
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, "")
    .replace(/<meta\b[^>]*http-equiv[^>]*>/gi, "")
    .replace(/<base\b[^>]*>/gi, "");
}
