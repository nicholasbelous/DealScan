# DealScan

## What it does

DealScan is a Chrome extension for Facebook Marketplace. On a listing page, it reads the listing, sends it to Claude using your own Anthropic API key, and shows a side panel with a score from 0 to 100, a verdict, a Buy / Negotiate / Pass recommendation, the asking price, an estimated used-market range, a suggested offer, and a one-sentence summary.

## How it works

1. On a `facebook.com/marketplace/item/*` page, the extension adds a floating **Evaluate Deal** button.
2. Clicking it opens the side panel, which starts the evaluation. Opening the panel from the toolbar icon, or moving to another listing with the panel open, only shows the listing title and an **Evaluate This Listing** button. No API call is made until you click.
3. The panel asks the scraper for the listing, retrying briefly because Facebook loads listing data after navigation. The scraper uses three sources, in priority order:
   - Embedded page JSON, used only if the object's `id` matches the item ID in the URL.
   - The listing panel: the smallest container around a link with a `product_id` parameter that also holds a title and price, and no links to other listings. Used only if that `product_id` matches the item ID in the URL. Only that parameter is read from the link.
   - The page itself, using the page title to find the listing title and the price next to it. This source is not tied to the item ID, so it only fills gaps.
4. A read is accepted only if the page JSON or listing panel supplied a title and price for the item ID in the URL, and an open panel doesn't name a different item. A panel read must also match the page title and, if a search card for the item is on the page, that card's title and price. If no read passes before the retries run out, the panel shows the reason and makes no API call. **Try Again** reloads the tab and reads the listing again, then shows the **Evaluate This Listing** button if the read passes.
5. The service worker checks for a saved result for that listing URL from the last hour. If there is one, the panel shows it, marked "cached".
6. Otherwise, if photo analysis is on, the service worker downloads up to three listing photos. Photos come only from the page JSON, so a read verified only from the panel is evaluated without photos. Photos that fail to download or are very small or very large are skipped.
7. The service worker sends, with seller-written text marked in the prompt as untrusted data, the title, category, price, condition, parsed year and mileage, location, the start of the description, and any photos to the Anthropic API. It retries on rate limits, server errors, and network failures.
8. Code validates the answer: required fields, a whole-number score from 0 to 100, a market range with low at or below high, a reasonable offer, a verdict that matches the score, and no good score on an above-market price. An invalid answer gets one retry, which is billed. If that also fails, or Claude declines, the panel shows the reason and no result.
   Code then replaces what it can compute: the asking price from the scrape, the percent above or below market, the verdict label from the score, and an offer capped at the asking price.
9. The panel shows the result, including which method verified the read (listing panel or page data). The result is tied to that listing's item ID: moving to another listing or tab clears it at once, and if an evaluation is still running when you move, its answer is discarded when it returns. That call is still billed, and its answer stays in the one-hour cache. **Save** adds it to local history, and the re-run button makes a new API call.

### Known limitation

The gate prefers refusing to guessing. A panel read is rejected if the panel contains links to other listings, such as a "more from this seller" section, because the panel's boundary can't then be trusted. Refreshing the page can get past this if Facebook provides page JSON after a reload.

Fields other than the title and price are not individually verified. After a panel read they come only from the panel. After a page JSON read, any the JSON lacks can come from the wider page, which is not tied to the item ID.

A panel read has no photos, so the same listing can get a different verdict depending on how you reached it. The result says when it was evaluated without photos. If a later read offers more photos than that evaluation had, for example after a reload, evaluating again makes a new API call. Otherwise the cached result is reused and the notice stays.

This logic is tested against fake pages in Chrome, not against saved Facebook HTML.

## Architecture

```
Facebook listing page                    Extension
+---------------------------+            +-----------------------------+
| Content scripts           |  scrape    | Side panel (UI)             |
|  scraper.js  reads page   |<---------->|  normalizes the scrape,     |
|  injector.js button       |  messages  |  shows the result, saves    |
|  observer.js navigation   |            |  history                    |
+-------------+-------------+            +--------------+--------------+
              | open panel                              | evaluate
              v                                         v
+-------------------------------------------------------------------------+
| Service worker: downloads photos, checks the result cache, calls Claude |
+------------+----------------------------------------+-------------------+
             |                                        |
             v                                        v
      fbcdn.net (photos)                     api.anthropic.com

Options page --> chrome.storage.local <-- service worker reads key and settings
```

- **Content scripts** run in the Facebook page. They read the listing and show the button, and they make no API calls.
- **Side panel** is the main UI. It asks the content script for a scrape and decides whether the scrape is usable. It has its own access to saved history.
- **Service worker** makes every network request: photo downloads and Anthropic API calls.
- **Options page** saves the API key and settings, and exports or clears history.

## Design decisions

**API calls only from the service worker.** The key never enters the Facebook page, and photos can be downloaded despite cross-origin limits. The tradeoff is extra message passing between the page, the panel, and the worker.

**User-supplied key stored locally.** There is no server to run and no shared bill, and listing data goes straight to Anthropic. The tradeoffs are that each user needs an Anthropic account and pays for their own usage, and the key sits unencrypted in `chrome.storage.local`, with calls made directly from the browser.

**Web search off by default, to keep cost down.** Each evaluation stays one request with no search charges. The tradeoff is that the price range is Claude's estimate from its own knowledge, which can be out of date or wrong. Users can turn search on in Options.

**Model output validated in code.** The API can enforce the JSON shape, but not ranges or whether an answer contradicts itself. So code rejects invalid answers and computes the arithmetic itself. The tradeoffs are that a retry costs a second API call, and that these rules don't check whether the market estimate itself is right. Web search mode doesn't send the JSON schema, because search results carry citations and the API docs list citations as incompatible with a JSON format, so it relies on the prompt and code validation.

**Same validation in both modes.** The server imports the prompt, validation, and pricing from `src/shared/`, so direct and server mode can't drift apart. The tradeoff is that shared code must stay free of browser-only and server-only calls, and the server has to be deployed alongside any change to it.

**Results bound to a run, not just a screen.** Every read and evaluation gets a run number, and navigating starts a new one, so a late answer can't land on the wrong listing. The tradeoff is that the discarded call was still paid for: it isn't cancelled, though its answer is cached if you go back.

**Evaluate only on an explicit click.** Browsing listings with the panel open never spends API credit. The tradeoff is an extra click when the panel is opened from the toolbar icon or after moving to another listing.

## Server mode (optional)

Direct mode is the default: the extension calls Anthropic with your own key, and no server is involved. Server mode sends evaluations through a small server you run instead.

**Why it exists:**

- **Key custody:** the Anthropic key lives only on the server, so someone with a token never holds a key. Using it from other machines would need a deployed server and a manifest change.
- **Measurement:** every evaluation is recorded with its outcome, tokens, cost, and latency, so cost and rejection claims can come from data.
- **Spending control:** a daily budget cap stops evaluations when it's reached. The server won't start without one. Each token is also rate limited.
- **Shared cache:** when anyone evaluates identical content, the server reuses the answer at no cost. The cache key is the item ID, a hash of the listing's normalized content including photos, the model, and the prompt version, so a changed price, description, or photo is a miss.

**Run it:**

```sh
npm install
cp server/.env.example server/.env   # then set ANTHROPIC_API_KEY and DAILY_BUDGET_USD
npm run token:create --workspace server -- your-name   # prints a token once
npm start --workspace server
```

In the extension's Options, choose **Server**, enter the URL and token, and save. Chrome asks for permission to reach it. For now the server must run on your own machine, at `http://localhost`: the extension isn't allowed to reach anywhere else.

**Endpoints:** `POST /v1/evaluate` takes the listing and any photos, and returns a validated verdict, a rejection, or a typed error such as `budget_exceeded`. `GET /v1/evaluations/:itemId` returns the latest evaluation for an item. `GET /v1/stats?window=24h|7d|30d|all` returns evaluations by status, top rejection reasons, cost and latency median and p90, and cache hit rate. Cost and latency cover only requests that reached the API, including retries and rejected answers. `GET /stats` is a simple page that shows the same numbers. It holds no data until you enter a token, and any valid token can read these server-wide totals. `GET /healthz` and the stats page's files need no token. Every other route needs `Authorization: Bearer <token>`.

**What it stores:** SQLite tables for listings (item ID, title, price, condition, category, description), evaluations, and hashed tokens. It never receives or stores seller data, and it rejects requests with fields it doesn't recognize. It doesn't store photos, and it never contacts Facebook: the extension downloads photos and sends them along. Web search isn't available in server mode.

Cache entries last an hour by default (`CACHE_TTL_SECONDS`). The rate limit defaults to 30 requests per minute per token (`RATE_LIMIT_PER_MINUTE`), counted in memory, so it resets when the server restarts. These are configuration defaults, not measurements.

The budget check runs before each evaluation, so requests already in progress can take spending slightly past the cap.

## Evaluation harness

`eval/` measures how the model does against your own labels. It isn't part of `npm test`, and against the real API it costs money.

```sh
cp eval/labels.template.csv my-labels.csv   # the template holds fake rows: replace them
npm run eval:import -- my-labels.csv
npm run eval                  # shows the plan and stops
npm run eval -- --mock        # a fake API: checks the pipeline, numbers mean nothing
npm run eval -- --confirm-paid   # real API calls, needs ANTHROPIC_API_KEY
```

It reports the price-range hit rate (how often your range overlaps the model's), score variance (5 listings run 5 times each), rejection precision, and cost and latency median and p90, including retries. Results go to `eval/results/<date>-<prompt_version>.json`. No results from real runs exist yet, so this repo makes no accuracy claims. Mock results are marked and aren't committed.

Limits: a label needs a listing already evaluated through the server, because the CSV has no asking price. Evaluations use stored text without photos, because the server keeps none. Rejection precision only covers rejected model answers, because the extension's gate rejections aren't recorded anywhere.

## Features

- **History tab:** search saved evaluations by title, filter by category, open or remove them. Each saved entry also records the model, prompt version, token counts, web searches, attempts, latency, and cost calculated from the pricing table in `src/shared/pricing.js`. The History tab shows each entry's cost.
- **Usage log:** every billed evaluation, saved or not, is logged locally with its status, tokens, and cost. The History tab shows the median, p90, and total from this log, so they include retries and rejected answers. Results served from the cache aren't logged, because they cost nothing.
- **Explicit states:** the panel is always in exactly one of not on Marketplace, reading, ready, evaluating, result, rejected, or error. Rejected means DealScan chose not to trust something. Error means something failed. See `src/shared/panel-state.js`.
- **Options page:**
  - API key
  - model: Haiku 4.5 (default), Sonnet 4.6, or Opus 4.8
  - photo analysis (on by default)
  - live web search for prices (off by default)
  - export history or the usage log as JSON, or clear them

With web search off, Claude estimates prices from its own knowledge, not from current listings.

## Setup

**Install:** from the [Chrome Web Store](https://chromewebstore.google.com/detail/dnidpjpakkallbhniigeiageaecnodck), or from source:

1. Open `chrome://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.

The extension has no build step and no dependencies. Only the optional server in `server/` has dependencies.

**Add your key:** right-click the DealScan icon, choose **Options**, paste your Anthropic API key from [console.anthropic.com](https://console.anthropic.com), and click **Save Settings**. API usage is billed to your Anthropic account.

## Project structure

```
manifest.json
src/
  background/service-worker.js   message routing, photo downloads, result cache
  content/scraper.js             combines the sources below into one read
  content/source-embedded.js     source: embedded page JSON
  content/source-panel.js        source: the verified listing panel
  content/source-page.js         source: the page itself, fills gaps only
  content/fields.js              condition, location, description, vehicle facts
  content/page-text.js           price shapes, page title, finding text
  content/injector.js            floating Evaluate Deal button
  content/observer.js            detects navigation between listings
  sidepanel/                     Evaluate and History tabs
  options/                       settings and history export
  shared/claude.js               direct mode: reads the key and settings
  shared/anthropic.js            Anthropic API call and retry on invalid output
  shared/stats.js                median and p90
  shared/server-client.js        server mode: calls the DealScan server
  shared/cache-key.js            hash of a listing's content
  shared/prompt.js               the system prompt and listing text
  shared/verdict.js              output schema, validation, finalizeVerdict
  shared/pricing.js              price table and cost calculation
  shared/gate.js                 the reliability gate: can this read be trusted
  shared/panel-state.js          side panel state machine, drops stale results
  shared/parser.js               normalizes the scrape into a listing
  shared/normalize.js            price and text cleanup
  shared/storage.js              settings and history in chrome.storage.local
  shared/categories.js           keyword-based category detection
  shared/formatter.js            display helpers
server/                          optional backend: Fastify, SQLite, migrations
eval/                            evaluation harness and labels template
assets/icons/                    extension icons
store-assets/                    Web Store images and source logo, not shipped
index.html, privacy-policy.html  GitHub Pages site, served from the repo root
privacy-policy-next.html         policy for this code, replaces privacy-policy.html at release
```

`npm test` runs the tests in `tests/` and `server/tests/` with Node's built-in test runner, after `npm install` for the server's dependencies. They cover price parsing, the reliability gate, listing normalization, and model output validation, with the API mocked. The scraper tests run against fake pages in headless Chrome. Without Chrome they skip on a developer's machine and fail in CI, where GitHub Actions runs `npm test` on every push and pull request. The tests don't call the Anthropic API.

## Data and privacy

- Your API key, settings, saved history, and usage log are stored in `chrome.storage.local`. They are not synced.
- Cached results are kept in `chrome.storage.session`, which clears when the browser closes.
- In direct mode, listing data and your key are sent only to the Anthropic API, with no DealScan server involved. In server mode, listing data and photos go to the server you configured, which sends them to Anthropic and stores what's listed above.
- The content scripts load on all `facebook.com` pages (see below). Outside listing pages they only watch the page address. The button only appears on listing pages, and the panel only reads listing pages.

### Why the content scripts match all of facebook.com

The manifest matches `https://*.facebook.com/*`, not just Marketplace. Chrome injects declared content scripts only on a full page load, and Facebook moves between pages without one. With a `/marketplace/*` match, a tab first loaded on the Facebook home page would get no scripts when you navigate in-app to a listing, so there would be no button and no navigation updates until you reload.

This was checked with a small test extension and a local page in Chrome: after `/` to `/marketplace/` to `/marketplace/item/1/` using `history.pushState`, the script had not run until the page was reloaded. A tab first loaded on `/marketplace/` kept its script when moving to an item. It has not been tested on live Facebook.

Narrowing the match would need the `webNavigation` permission and code that injects the scripts on navigation.

## Roadmap

**None of this is built yet.**

- Scraper tests against saved, sanitized listing pages
- Photos from the verified listing panel
- Red and green flags and negotiation tips in the result
- Recording gate rejections, so rejection precision covers them
