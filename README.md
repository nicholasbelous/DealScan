# DealScan

## What it does

DealScan is a Chrome extension for Facebook Marketplace. On a listing page, it reads the listing, sends it to Claude using your own Anthropic API key, and shows a side panel with a score from 0 to 100, a verdict, a Buy / Negotiate / Pass recommendation, the asking price, an estimated used-market range, a suggested offer, and a one-sentence summary.

## How it works

1. On a `facebook.com/marketplace/item/*` page, the extension adds a floating **Evaluate Deal** button.
2. Clicking it opens the side panel, which starts the evaluation. Opening the panel from the toolbar icon, or moving to another listing with the panel open, only shows the listing title and an **Evaluate This Listing** button. No API call is made until you click.
3. The panel asks the scraper for the listing, retrying briefly because Facebook loads listing data after navigation. The scraper uses three sources, in priority order:
   - Embedded page JSON, used only if the object's `id` matches the item ID in the URL.
   - Meta tags, used only if `og:url` contains that item ID.
   - The page itself, using the page title to find the listing title and the price next to it. This source is not tied to the item ID.
4. If no title or price can be read, the panel says it couldn't read the listing and makes no API call.
5. The service worker checks for a saved result for that listing URL from the last hour. If there is one, the panel shows it, marked "cached".
6. Otherwise, if photo analysis is on, the service worker downloads up to three listing photos. Photos come only from the page JSON and the `og:image` tag. Photos that fail to download or are very small or very large are skipped.
7. The service worker sends the title, category, price, condition, parsed year and mileage, location, the start of the description, and any photos to the Anthropic API. It retries on rate limits, server errors, and network failures.
8. Code then corrects the response: it takes the asking price from the scrape, clamps the score, calculates the percent above or below market, sets the verdict label from the score, and caps the suggested offer at the asking price.
9. The panel shows the result. **Save** adds it to local history, and the re-run button makes a new API call.

### Known limitation

An item ID match is not required. If only the page source has data, the panel looks for two matching reads in a row, but if it runs out of retries it can still accept the last read as long as that read has a title and a price. In that case the result could describe the wrong listing, so check that the title and price in the panel match the page.

## Features

- **History tab:** search saved evaluations by title, filter by category, open or remove them.
- **Options page:**
  - API key
  - model: Haiku 4.5 (default), Sonnet 4.6, or Opus 4.8
  - photo analysis (on by default)
  - live web search for prices (off by default)
  - export history as JSON, or clear it

With web search off, Claude estimates prices from its own knowledge, not from current listings.

## Setup

**Install:** from the [Chrome Web Store](https://chromewebstore.google.com/detail/dnidpjpakkallbhniigeiageaecnodck), or from source:

1. Open `chrome://extensions/` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.

There is no build step and there are no dependencies.

**Add your key:** right-click the DealScan icon, choose **Options**, paste your Anthropic API key from [console.anthropic.com](https://console.anthropic.com), and click **Save Settings**. API usage is billed to your Anthropic account.

## Project structure

```
manifest.json
src/
  background/service-worker.js   message routing, photo downloads, result cache
  content/scraper.js             reads the listing
  content/injector.js            floating Evaluate Deal button
  content/observer.js            detects navigation between listings
  sidepanel/                     Evaluate and History tabs
  options/                       settings and history export
  shared/claude.js               prompt, Anthropic API call, response corrections
  shared/parser.js               normalizes the scrape, decides if it is usable
  shared/storage.js              settings and history in chrome.storage.local
  shared/categories.js           keyword-based category detection
  shared/formatter.js            display helpers
assets/icons/                    extension icons
store-assets/                    Web Store images and source logo, not shipped
index.html, privacy-policy.html  GitHub Pages site, served from the repo root
```

There are no automated tests.

## Data and privacy

- Your API key, settings, and saved history are stored in `chrome.storage.local`. They are not synced.
- Cached results are kept in `chrome.storage.session`, which clears when the browser closes.
- Listing data and your key are sent only to the Anthropic API. There is no DealScan server.
- The content scripts load on all `facebook.com` pages so they can detect in-app navigation to a listing. The button only appears on listing pages.

## Roadmap

**None of this is built yet.**

- Require a verified item ID before accepting a read
- Narrow the content script match to Marketplace, if navigation detection allows it
- Unit tests, scraper fixtures, and CI
- Schema validation of model output with one retry, and delimiters around seller-written text
- Usage data stored with each history entry
- Red and green flags and negotiation tips in the result
- Explicit side panel states, with results tied to an item ID
- Optional backend that holds the API key, caches results, logs usage, and enforces a spend limit
- Evaluation harness and a stats page
