// Runs the real content scripts in a page and returns what they read.

import fs from "node:fs";

// In manifest order, minus the two with side effects.
const manifest = JSON.parse(fs.readFileSync(new URL("../../manifest.json", import.meta.url), "utf8"));
const scraperSource = manifest.content_scripts[0].js
  .filter((file) => !/injector|observer/.test(file))
  .map((file) => fs.readFileSync(new URL(`../../${file}`, import.meta.url), "utf8"))
  .join("\n");

export async function runScraper(page) {
  const out = await page.evaluate(`(() => {
    let handler;
    window.chrome = { runtime: { onMessage: { addListener: (h) => (handler = h) } } };
    console.debug = () => {};
    ${scraperSource}
    let out;
    handler({ type: "SCRAPE_LISTING" }, null, (r) => (out = r));
    return out;
  })()`);
  if (!out?.ok) throw new Error(`The scraper failed: ${JSON.stringify(out)}`);
  return out.data;
}
