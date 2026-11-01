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
7. The service worker sends the title, category, price, condition, parsed year and mileage, location, the start of the description, and any photos to the Anthropic API. It retries on rate limits, server errors, and network failures.
8. Code then corrects the response: it takes the asking price from the scrape, clamps the score, calculates the percent above or below market, sets the verdict label from the score, and caps the suggested offer at the asking price.
9. The panel shows the result, including which method verified the read (listing panel or page data). **Save** adds it to local history, and the re-run button makes a new API call.

### Known limitation

The gate prefers refusing to guessing. A panel read is rejected if the panel contains links to other listings, such as a "more from this seller" section, because the panel's boundary can't then be trusted. Refreshing the page can get past this if Facebook provides page JSON after a reload.

Fields other than the title and price are not individually verified. After a panel read they come only from the panel. After a page JSON read, any the JSON lacks can come from the wider page, which is not tied to the item ID.

A panel read has no photos, so the same listing can get a different verdict depending on how you reached it. The result says when it was evaluated without photos. After a reload, if the page provides photos, evaluating again makes a new API call instead of reusing the cached result without photos.

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

**Verdict consistency enforced in code.** The model could return a label that contradicts its score, or get the arithmetic wrong. So code sets the verdict from the score, calculates the percent above or below market, takes the asking price from the scrape, and caps the offer. The tradeoff is that these rules can override the model and hide its mistakes. They also don't check whether the market estimate itself is right.

**Evaluate only on an explicit click.** Browsing listings with the panel open never spends API credit. The tradeoff is an extra click when the panel is opened from the toolbar icon or after moving to another listing.

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

`npm test` runs the unit tests in `tests/` with Node's built-in test runner. They cover price parsing, the reliability gate, listing normalization, and the response corrections. The scraper tests run against fake pages in headless Chrome and are skipped if Chrome isn't installed. The tests don't call the Anthropic API.

## Data and privacy

- Your API key, settings, and saved history are stored in `chrome.storage.local`. They are not synced.
- Cached results are kept in `chrome.storage.session`, which clears when the browser closes.
- Listing data and your key are sent only to the Anthropic API. There is no DealScan server.
- The content scripts load on all `facebook.com` pages (see below). Outside listing pages they only watch the page address. The button only appears on listing pages, and the panel only reads listing pages.

### Why the content scripts match all of facebook.com

The manifest matches `https://*.facebook.com/*`, not just Marketplace. Chrome injects declared content scripts only on a full page load, and Facebook moves between pages without one. With a `/marketplace/*` match, a tab first loaded on the Facebook home page would get no scripts when you navigate in-app to a listing, so there would be no button and no navigation updates until you reload.

This was checked with a small test extension and a local page in Chrome: after `/` to `/marketplace/` to `/marketplace/item/1/` using `history.pushState`, the script had not run until the page was reloaded. A tab first loaded on `/marketplace/` kept its script when moving to an item. It has not been tested on live Facebook.

Narrowing the match would need the `webNavigation` permission and code that injects the scripts on navigation.

## Roadmap

**None of this is built yet.**

- Scraper fixture tests and CI
- Schema validation of model output with one retry, and delimiters around seller-written text
- Usage data stored with each history entry
- Red and green flags and negotiation tips in the result
- Explicit side panel states, with results tied to an item ID
- Optional backend that holds the API key, caches results, logs usage, and enforces a spend limit
- Evaluation harness and a stats page
