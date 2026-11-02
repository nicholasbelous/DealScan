# Code map

Every source file, grouped by area, with one line on what it does. The diagrams in [ARCHITECTURE.md](ARCHITECTURE.md) show how the pieces connect.

## Start reading here

This order follows one evaluation through the code:

1. [OVERVIEW.md](OVERVIEW.md), then [ARCHITECTURE.md](ARCHITECTURE.md): what it does, then the pieces and one evaluation as simple diagrams.
2. `manifest.json`: what loads where, and the permissions.
3. `src/content/scraper.js`: what a read of the page contains, and where each field comes from.
4. `src/shared/gate.js`: whether a read can be trusted. The first refusal point.
5. `src/shared/panel-state.js`: the side panel's states, and how stale results are dropped.
6. `src/sidepanel/sidepanel.js`, the "Evaluate flow" section: reads, retries, and handing off to the service worker.
7. `src/background/service-worker.js`: photos, the result cache, and the call.
8. `src/shared/anthropic.js` and `src/shared/prompt.js`: the API request and what it says.
9. `src/shared/verdict.js`: whether the answer can be trusted, and what code computes itself. The second refusal point.
10. `server/src/routes/evaluate.js`: the same evaluation behind auth, a budget, and a cache.

Then [DECISIONS.md](DECISIONS.md) for why, and `tests/parser.test.js`, `tests/verdict.test.js`, and `tests/panel.browser.test.js` to see the rules pinned down.

## Extension

The extension has no build step and no dependencies. Chrome loads these files as they are.

### Content scripts (`src/content/`)

They run in every `facebook.com` tab, in the order `manifest.json` lists them, and share one object, `window.__dealscan`. They read the page and never make network calls.

| File | What it does |
|---|---|
| `page-text.js` | Shared text helpers: price shapes, cleaning up the page title, finding an element by its text, and finding the price after the title. |
| `fields.js` | Reads condition, location, description, year, and mileage, each from a given container so a verified panel reads only itself. |
| `source-embedded.js` | Source 1: the page's embedded JSON, walked to the object whose `id` equals the URL's item ID. The only source of photos. |
| `source-panel.js` | Source 2: the listing panel around a `product_id` link, plus the page title and search card cross-checks. Reads only the `product_id` parameter from those links. |
| `source-page.js` | Source 3: the page title and the price beside it. Not tied to an item ID, so it only fills gaps. |
| `scraper.js` | Combines the three sources into one read and answers the panel's `SCRAPE_LISTING` message. Decides nothing. |
| `injector.js` | Adds the floating **Evaluate Deal** button on listing pages and sends `OPEN_SIDE_PANEL`. |
| `observer.js` | Watches for Facebook's in-app URL changes, then tells the injector and sends `LISTING_CHANGED` to the panel. |

### Side panel (`src/sidepanel/`)

| File | What it does |
|---|---|
| `sidepanel.js` | The main UI. Reads the listing with retries, runs the gate, sends `EVALUATE_LISTING`, and renders only what the state machine says. Also the History tab. |
| `sidepanel.html` | One section per panel state, the result view, and the History tab. |
| `sidepanel.css` | Panel styles. |

### Service worker (`src/background/`)

| File | What it does |
|---|---|
| `service-worker.js` | The only network client. Opens the panel, downloads photos, keeps the one-hour result cache, calls Anthropic or the server, and logs usage. |

### Options page (`src/options/`)

| File | What it does |
|---|---|
| `options.js` | Saves the mode, API key or server URL and token, model, and photo and web search options. Asks for permission to reach a local server. Exports or clears local data. |
| `options.html` | The options form. |
| `options.css` | Options page styles. |

### Shared logic (`src/shared/`)

Only `storage.js` calls `chrome.*`, and `claude.js` reads settings through it. The server imports the modules it needs, so the prompt, validation, and pricing are the same in both modes.

| File | What it does |
|---|---|
| `gate.js` | `checkRead()`: whether a read can be trusted, with a plain reason. Also the privacy-safe record of a refused read. |
| `parser.js` | Turns a raw read into a clean listing and records the gate's decision on it. Also the rule for reusing a cached result made without photos. |
| `normalize.js` | Price parsing (including "Free"), currency symbols, and whitespace cleanup. |
| `categories.js` | Keyword-based category detection, for a hint in the prompt and the History filter. |
| `panel-state.js` | The side panel state machine: a pure reducer with run numbers. |
| `prompt.js` | The system prompt, the scoring guide generated from `SCORE_BANDS`, and the listing text with seller fields inside `<untrusted_listing>`. |
| `anthropic.js` | One evaluation against the Messages API: request, transport retries, validation, and one retry on an invalid answer. Used by both modes. |
| `verdict.js` | `SCORE_BANDS`, the output schema, validation, `finalizeVerdict()`, and what a saved history entry keeps. |
| `pricing.js` | The price table, with its source and date, and cost from API usage. An unknown model costs `null`, never a guess. |
| `cache-key.js` | SHA-256 of a listing's normalized content and photos, for the server's cache. |
| `claude.js` | Direct mode: reads the user's key and settings and calls `runEvaluation()`. |
| `server-client.js` | Server mode: sends the listing to the DealScan server and maps its responses to the same results and errors. |
| `storage.js` | `chrome.storage.local`: settings, history, the usage log, and the read rejection log. |
| `stats.js` | Nearest-rank median and p90, the cost summary, and top reasons. Used by the panel, the server, and the eval harness. |
| `formatter.js` | Display helpers: money, cost, dates, score colors, the no-photos notice, and where the price sits against the market range. |

## Server (`server/`)

Optional. Node with Fastify, `better-sqlite3`, and `@fastify/rate-limit`, set up as an npm workspace.

| File | What it does |
|---|---|
| `src/index.js` | Starts the server: config, database, app. |
| `src/config.js` | Reads env vars. Refuses to start without an API key and a daily budget. |
| `src/app.js` | The Fastify app: error shapes, `/healthz`, the stats page files, token auth, the per-token rate limit, and the authenticated routes. |
| `src/routes/evaluate.js` | `POST /v1/evaluate`: the body schema, content hash, cache, budget check, evaluation, and recording every outcome. |
| `src/store.js` | All SQL for listings and evaluations: remember, record, cache lookup, spend today, latest, and rows for stats. |
| `src/tokens.js` | Creates, finds, and revokes tokens. Stores only their SHA-256. |
| `src/stats.js` | Aggregates for `GET /v1/stats` over a time window. |
| `src/db.js` | Opens SQLite and applies numbered migrations in order. |
| `migrations/001_initial.sql` | Tables for tokens, listings, evaluations, and labels. |
| `migrations/002_cache_lookup.sql` | Index for the cache lookup. |
| `migrations/003_label_titles.sql` | Adds a title to labels. |
| `public/stats.html`, `stats.js`, `stats.css` | The stats page. Holds no data until a token is entered, and sends the token only in a header. |
| `scripts/create-token.js` | `npm run token:create --workspace server -- <name>`: prints a new token once. |
| `.env.example` | The environment variables, with their defaults. |
| `package.json` | Server dependencies and its `start` and `token:create` scripts. |

## Evaluation harness (`eval/`)

Run by hand, never by `npm test`. Against the real API it costs money and refuses to start without `--confirm-paid`.

| File | What it does |
|---|---|
| `run.js` | `npm run eval`: shows the plan, then runs it with `--mock` or `--confirm-paid` and writes a results file. |
| `harness.js` | Joins labels to stored listings, plans repeated runs, and runs them through a given `evaluate` function. |
| `metrics.js` | Price range hit rate, score spread, rejection precision, and cost and latency. |
| `labels.js` | Parses and checks the labels CSV, and saves labels. |
| `import-labels.js` | `npm run eval:import -- <file.csv>`: imports labels, all or nothing. |
| `mock-api.js` | A fake Anthropic API for `--mock` and tests. Its numbers mean nothing. |
| `labels.template.csv` | The CSV format, with fake rows. |
| `results/` | Where results files go. Mock results are gitignored. |

## Scripts (`scripts/`)

| File | What it does |
|---|---|
| `sanitize-fixture.js` | `npm run fixture:sanitize`: turns a saved Facebook page into a fake fixture for review. |
| `lib/sanitize-page.js` | Runs inside the saved page: replaces everything not on a short list of Facebook's own labels. |
| `lib/fixture-checks.js` | Leak checks on sanitized HTML. Nothing is written if one fails. |
| `lib/chrome.js` | A small headless Chrome driver over the DevTools pipe, for the browser tests and the sanitizer. |
| `lib/run-scraper.js` | Loads the content scripts in a page, in manifest order, and returns what they read. |

## Tests (`tests/`, `server/tests/`)

See [TESTING.md](TESTING.md) for what each kind covers and how to run it.

| File | What it does |
|---|---|
| `tests/parser.test.js` | Price parsing, the gate, listing normalization, and cached no-photos reuse. |
| `tests/verdict.test.js` | Validation, retry decisions, the schema, score bands, and `finalizeVerdict()`. |
| `tests/evaluate.test.js` | Direct-mode evaluation end to end with `fetch` mocked, including injection and retry cases. |
| `tests/prompt.test.js` | Delimiting of seller text and the generated scoring guide. |
| `tests/panel-state.test.js` | The state machine's transitions and races, as a pure reducer. |
| `tests/pricing.test.js` | Cost from usage. |
| `tests/stats.test.js` | Percentiles, the cost summary, and top reasons. |
| `tests/formatter.test.js` | The no-photos notice, market position, and cost formatting. |
| `tests/usage-log.test.js` | The local usage and read rejection logs, with storage stubbed. |
| `tests/server-client.test.js` | Server mode's client with `fetch` mocked. |
| `tests/eval.test.js` | The eval harness with the fake API, and the paid path refusing to start. |
| `tests/scraper.browser.test.js` | The real content scripts on fake pages in headless Chrome. |
| `tests/panel.browser.test.js` | The real side panel page in headless Chrome, with `chrome.*` stubbed: races, the page button, logging. |
| `tests/fixtures.browser.test.js` | The sanitizer on a fake page seeded with fake secrets, and every reviewed fixture. |
| `tests/fixtures/README.md` | How to capture, sanitize, and review a real page. |
| `server/tests/helpers.js` | An in-memory database, a test app, and a mocked Anthropic API. |
| `server/tests/evaluate.test.js` | The evaluate route, auth, the budget, input checks, and what is stored and logged. |
| `server/tests/phase2.test.js` | The cache, the rate limit, and stats. |
| `server/tests/setup.test.js` | Config and migrations. |

## Repository root

| File | What it does |
|---|---|
| `manifest.json` | The extension manifest: permissions, content scripts and their order, panel, and options page. |
| `package.json` | Test, eval, and fixture scripts, and the server workspace. |
| `README.md` | What DealScan does, setup, and links to these docs. |
| `CHANGELOG.md` | What changed in each release. |
| `CLAUDE.md` | Project rules and the target design, for AI-assisted work in this repo. |
| `index.html` | GitHub Pages landing page: link-preview data for crawlers, and a redirect to the Chrome Web Store. |
| `privacy-policy.html` | The privacy policy for the published version, served by GitHub Pages. |
| `privacy-policy-next.html` | The privacy policy for the code on this branch. Replaces `privacy-policy.html` at release. |
| `.github/workflows/test.yml` | CI: runs `npm test` on every push and pull request, and fails if Chrome is missing. |
| `assets/icons/` | Extension icons. |
| `store-assets/` | Chrome Web Store images and the source logo. Not part of the extension. |
