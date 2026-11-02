# Testing

DealScan has two things it can't control: Facebook's page and the model's answer. The automated tests pin down DealScan's own behavior around both, using fake pages and a mocked API. They never call the Anthropic API or contact Facebook. What they can't show, how real pages and the real model behave, is covered by the manual live tests at the end, and by the eval harness once it has real labels.

## Kinds of test

| Kind | Where | What it covers | Runs in `npm test` |
|---|---|---|---|
| Unit | `tests/*.test.js` | Pure logic: price parsing, the gate, normalization, validation and `finalizeVerdict()`, the prompt's delimiting, the state machine, pricing, stats, formatting, logs. | Yes |
| Headless Chrome | `tests/*.browser.test.js` | The real content scripts on fake pages, the real side panel page with `chrome.*` stubbed, and the fixture sanitizer. | Yes, if Chrome is found |
| Server | `server/tests/` | The Fastify app through `app.inject()`, with a real in-memory SQLite database and a mocked Anthropic API. | Yes |
| Eval harness | `eval/` | How the model does against human labels. | No. Run by hand, and paid unless `--mock` |
| Live tests | the checklist below | Real Facebook pages, the real model, and Chrome prompts that can't be automated. | No |

## What's mocked, and why

- **The Anthropic API.** `globalThis.fetch` is replaced in `tests/evaluate.test.js`, `server/tests/helpers.js`, and `eval/mock-api.js`. Real calls cost money and don't give the same answer twice. The tests check what DealScan does with an answer, including malformed JSON, cut-off output, refusals, contradictions, and an obeyed injection, not what the model would say.
- **The DealScan server**, in `tests/server-client.test.js`: `fetch` is mocked to return each status the server can send.
- **`chrome.*`.**
  - `tests/panel.browser.test.js` loads the real `sidepanel.html` and stubs `chrome.runtime`, `chrome.tabs`, and both storage areas, including `onChanged`. The stub holds each evaluation's response open until the test releases it, which is how the race between a slow answer and navigation is tested.
  - `tests/usage-log.test.js` stubs `chrome.storage.local`.
  - `scripts/lib/run-scraper.js` stubs only `chrome.runtime.onMessage`, to call the scraper.
- **Facebook.** The browser tests serve fake pages from a local HTTP server, with made-up IDs, titles, and prices. Saved Facebook pages hold session data and real people's details, so they can only enter the repo through the sanitizer and a human review. See `tests/fixtures/README.md`. None have been captured yet, so the "reviewed fixtures" test is skipped.
- **Time, on the server.** `buildApp()` takes a `now` function, so tests can move the clock for cache expiry and the budget's UTC day.

SQLite is not mocked. Server tests use a real database in memory, and migration tests use a temporary directory.

## How to run

```sh
npm install                              # the server's dependencies; the extension has none
npm test                                 # everything below except the eval harness
node --test tests/verdict.test.js        # one file
node --test server/tests/                # only the server
CHROME_PATH=/path/to/chrome npm test     # use a specific Chrome
```

The browser tests look for Chrome in the usual macOS and Linux locations, or at `CHROME_PATH`. Without Chrome they skip on a developer's machine and fail in CI, where `CI` is set, so a missing browser can't pass silently. GitHub Actions (`.github/workflows/test.yml`) runs `npm ci`, checks that Chrome is installed, and runs `npm test` on every push and pull request.

**Eval harness.** This costs money against the real API:

```sh
npm run eval:import -- my-labels.csv     # from eval/labels.template.csv, with real rows
npm run eval                             # shows the plan and stops
npm run eval -- --mock                   # fake API: checks the pipeline, numbers mean nothing
npm run eval -- --confirm-paid           # real API, needs ANTHROPIC_API_KEY
```

A label needs a listing already evaluated in server mode, because the CSV has no asking price. Results go to `eval/results/<date>-<prompt_version>.json`. Mock results are marked and gitignored, and can't back any claim. No real run exists yet.

**Fixtures from real pages.** Follow `tests/fixtures/README.md`: save a page into the gitignored `tests/fixtures/raw/`, then run `npm run fixture:sanitize`. Read the output in the gitignored `tests/fixtures/review/`, and only then move it to `tests/fixtures/`. `npm test` runs the scraper on every `.html` file there and checks it for leaks again.

## Manual live tests

Run these before a release, and after any change to the content scripts, the prompt, or the panel. Items marked **paid** make Anthropic API calls.

**Before you start:** reload the extension in `chrome://extensions`, then refresh every open Facebook tab. Tabs that were already open keep the old content scripts, which can no longer reach the extension, so in-app navigation stops updating the panel until the page is refreshed.

1. **Default model, paid.** In direct mode with the default model and web search off, evaluate one listing. A result appears on the first attempt. Save it, export history from Options, and check `evaluation.promptVersion` and `evaluation.attempts`.
2. **A listing reached by clicking.** From search results, click into a listing. The panel previews it as "Verified: listing panel". If you evaluate (**paid**), the result says "Evaluated without photos: reload to include them."
3. **The same listing after a reload.** Reload the page. With the page console's level including Verbose, the `[DealScan] scrape` line shows `photos:` above 0. Evaluating (**paid**) shows "Verified: page data" and a photo count, and the service worker's Network tab shows up to 3 `fbcdn.net` requests before the API call.
4. **The race, paid.** Start an evaluation, then click to another listing before it finishes. The old verdict never appears, and the panel shows the new listing.
5. **The page's Evaluate Deal button, paid.**
   - With the panel closed, click it: the panel opens and starts evaluating.
   - With the panel open on the History tab, double-click it on a listing not evaluated in the last hour. The panel switches to Evaluate, and the service worker's Network tab shows exactly one API request.
   - With that result on screen, click it again: no new request.
6. **Market position.** On a result whose asking price is inside the market range, the "vs market" cell says "Within market range". A percentage appears only outside the range.
7. **Read rejection log.** Browse until a read is refused. The History tab shows the top reasons, and the export from Options holds only time, reason, method, and item ID.
8. **Cost.** After a few evaluations, the History tab shows the measured median, p90, and total. Compare an entry's `costUsd` with the Anthropic console, and check `src/shared/pricing.js` against Anthropic's pricing page.
9. **Sanitizer on a real page.** Sanitize one saved listing and read every line of the output for anything real: names, places, prices, photos, IDs.
10. **Server mode, paid.**
    1. Run the server locally with a small `DAILY_BUDGET_USD`.
    2. In Options choose **Server**, enter `http://localhost:3000` and a token, and save. Chrome asks for permission to reach it.
    3. Evaluate a listing, then press the re-run button (↻). Re-run skips the extension's own one-hour cache, so the request reaches the server, which answers from its cache: the result is marked cached and costs nothing. Clicking Evaluate again instead is answered by the extension's cache, and the server never sees it.
    4. Open `/stats`, enter the token, and check the cache hit rate.
11. **Optional, paid:** web search mode, where no JSON schema is sent, and a listing whose description tries an injection.
