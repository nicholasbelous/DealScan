# DealScan

A Chrome extension for Facebook Marketplace. On a listing page, it reads the listing, asks Claude to evaluate it, and shows a side panel with a score from 0 to 100, a verdict, a Buy / Negotiate / Pass recommendation, the asking price, an estimated used-market range, a suggested offer, and a one-sentence summary.

Two things in that path can be wrong: the read of the page, and Claude's answer. DealScan checks both, and when either check fails it refuses and says why, rather than showing a confident answer about the wrong thing.

## Documentation

- [Architecture](docs/ARCHITECTURE.md): diagrams of the system, one evaluation, the side panel's states, the server, and the database.
- [Design decisions](docs/DECISIONS.md): what was chosen, what was rejected, and the tradeoffs.
- [Code map](docs/CODEMAP.md): every file in one line, and where to start reading.
- [Testing](docs/TESTING.md): what the tests cover, what's mocked, and the live test checklist.
- [Changelog](CHANGELOG.md)
- [Privacy policy for this version](privacy-policy-next.html). The [published policy](privacy-policy.html) covers 1.2.1, the version on the Chrome Web Store.

## How it works

1. On a listing page, click the floating **Evaluate Deal** button, or open the panel and click **Evaluate This Listing**. Opening the panel or moving between listings only previews, and nothing is sent until you click.
2. The panel reads the listing. The read is accepted only if the page's own data, or the listing panel, ties the title and price to the item ID in the page address. Otherwise DealScan refuses, shows the reason, and makes no API call.
3. The service worker downloads up to three listing photos and sends the listing to Claude, with the seller's text marked as untrusted data.
4. Code checks the answer. An invalid one gets one retry, and then DealScan refuses it. Code, not Claude, sets the verdict and recommendation from the score, computes the percent versus the market, and caps the offer at the asking price.
5. The result is tied to that listing. If you move to another listing before the answer arrives, it's discarded.

## Install

From the [Chrome Web Store](https://chromewebstore.google.com/detail/dnidpjpakkallbhniigeiageaecnodck), or from source:

1. Open `chrome://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.

The extension has no build step and no dependencies.

Then right-click the DealScan icon, choose **Options**, paste an Anthropic API key from [console.anthropic.com](https://console.anthropic.com), and save. API usage is billed to your Anthropic account.

**In Options** you can choose:
- the model: Haiku 4.5 (default), Sonnet 4.6, or Opus 4.8
- photo analysis (on by default)
- live web search for prices (off by default)
- direct or server mode

You can also export or clear your history, usage log, and read rejection log. With web search off, Claude estimates prices from its own knowledge, not from current listings.

**In the History tab** you can search and filter saved evaluations and see each one's cost. It also shows the measured median, 90th percentile, and total cost of recent evaluations, and the most common reasons a read was refused.

## Limits

- DealScan prefers refusing to guessing, so it sometimes refuses a valid listing. For example, a listing panel that contains a "more from this seller" section can't be trusted as one listing. Reloading the page can get past this, when Facebook includes the listing's data after a reload.
- A listing reached by clicking inside Facebook is evaluated without photos, so the verdict can differ from the one after a reload. The result says when photos were missing and why.
- Only the title and price are verified against the item ID. Other fields come from the same panel, or, after a reload, from the page data and the wider page.
- In direct mode a result is reused for an hour per listing address, so a price change within that hour shows the old result. The re-run button makes a new call.
- The page-reading logic is tested against fake pages, not saved Facebook pages.
- Accuracy hasn't been measured. The evaluation harness exists, but no run against the real API has been done, so this repo makes no accuracy claims.

## Server mode (optional)

Direct mode is the default: the extension calls Anthropic with your own key. Server mode sends evaluations to a small server you run instead, which:
- keeps the key off the browser
- records every evaluation with its cost and outcome
- enforces a daily budget and a per-token rate limit
- reuses answers for identical content

For now the server must run on your own machine, at `http://localhost`.

```sh
npm install
cp server/.env.example server/.env                     # set ANTHROPIC_API_KEY and DAILY_BUDGET_USD
npm run token:create --workspace server -- your-name   # prints a token once
npm start --workspace server
```

In Options, choose **Server**, enter the URL and token, and save. Chrome asks for permission to reach it.

The server's endpoints:
- `POST /v1/evaluate`
- `GET /v1/evaluations/:itemId`
- `GET /v1/stats?window=24h|7d|30d|all`
- `GET /healthz`
- `GET /stats`, a page showing the stats

Everything except `/healthz` and the stats page's files needs `Authorization: Bearer <token>`. The request path and the database are diagrammed in [ARCHITECTURE.md](docs/ARCHITECTURE.md#server-request-path). Cache lifetime and the rate limit are configured in `server/.env`.

## Development

```sh
npm install      # the server's dependencies
npm test         # all tests: unit, headless Chrome, and server; none call the Anthropic API
npm run eval     # the evaluation harness: shows its plan, and costs money only with --confirm-paid
```

GitHub Actions runs `npm test` on every push and pull request. See [TESTING.md](docs/TESTING.md) for running single suites, the mocks, real-page fixtures, and the live test checklist.

## Data and privacy

- Your API key, settings, saved history, usage log, and read rejection log are stored in `chrome.storage.local`. They aren't synced.
- Recent results are cached in `chrome.storage.session`, which clears when the browser closes.
- In direct mode, listing data and your key go only to the Anthropic API. In server mode, listing data and photos go to the server you configured, which sends them to Anthropic and stores the listing's title, price, condition, category, and description, and each evaluation, but not photos.
- The seller's name isn't read. From the links on the listing that point to the seller's profile, only the listing ID is used. The seller's profile ID isn't read, stored, logged, or sent. Text and photos are sent as they appear in the listing, so a name the seller wrote into the description is included.
- The content scripts load on all `facebook.com` pages so they can follow navigation inside Facebook (see [decision 13](docs/DECISIONS.md#13-content-scripts-load-on-all-of-facebookcom)). Outside listing pages they only watch the page address.

## Roadmap

None of this is built yet:
- Capturing sanitized real listing pages as test fixtures. The sanitizer exists, and none have been captured.
- Photos from the verified listing panel.
- Red and green flags and negotiation tips in the result.
- Feeding the read rejection log into the evaluation harness.
