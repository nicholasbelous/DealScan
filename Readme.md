# DealScan — Marketplace Deal Evaluator

> A Chrome extension that evaluates Facebook Marketplace listings with Claude AI. Open a listing, get a deal score, a market-price range, and a suggested offer — without leaving the page.

---

## What it does

- **Reliable scraping** — reads the listing's real title, price, condition, description, and photos, verified against the item ID in the URL. If it can't read a listing confidently, it says so and refuses to evaluate rather than show you wrong data (and doesn't spend any API credit).
- **AI evaluation** — sends the listing to Claude and returns a clean, focused verdict:
  - Deal score (0–100) and verdict (Great Deal → Avoid)
  - Recommendation: Buy / Negotiate / Pass
  - Asking price vs. used-market range
  - Suggested offer and % below/above market
  - A one-line summary
- **Photo analysis** (on by default) — Claude looks at the first 2–3 listing photos to judge real condition and catch stock-photo scams.
- **Vehicle-aware** — pulls mileage and year for cars so pricing reflects them.
- **Persistent side panel** — stays open while you browse; a floating "Evaluate Deal" button is injected onto listing pages; re-detects new listings as you navigate (no page reload needed).
- **History & watchlist** — save evaluations locally, search/filter them, or keep listings on a watchlist. Export history as JSON.

## Cost

Each evaluation is one Claude API call. With the defaults (Haiku model, photos on, web search off), a scan costs roughly **½–¾¢**. The $5 of free credit a new Anthropic account gets covers hundreds of scans. Options let you trade cost for accuracy:

| Setting | Cost / scan | Notes |
|---|---|---|
| Default (Haiku + photos) | ~½–¾¢ | Prices estimated from Claude's knowledge |
| Photos off | ~⅕¢ | Text only |
| Web search on | ~3–8¢ | Live current prices (good for big purchases) |

Re-opening the same listing within an hour is free (cached). A refused scan costs nothing.

---

## Project structure

```
manifest.json                      # MV3 config — permissions, service worker, side panel
.env.example                       # documents the Anthropic key (entered via Options, not a file)
src/
├── background/
│   └── service-worker.js          # message router, image fetching, Claude API calls, verdict cache
├── content/
│   ├── scraper.js                 # verified hybrid scrape (JSON + meta + DOM)
│   ├── injector.js                # floating "Evaluate Deal" button
│   └── observer.js                # detects SPA navigation between listings
├── sidepanel/                     # primary UI — Evaluate / History / Watchlist
│   ├── sidepanel.html / .js / .css
├── options/                       # API key, model, photo + web-search toggles, data export
│   ├── options.html / .js / .css
└── shared/
    ├── claude.js                  # Anthropic API wrapper (vision + optional web search)
    ├── storage.js                 # chrome.storage wrapper (settings / history / watchlist)
    ├── parser.js                  # normalizes a raw scrape + the reliability gate
    ├── formatter.js               # money / date / score display helpers
    └── categories.js              # category detection
assets/icons/                      # icon16 / icon48 / icon128
```

Vanilla JavaScript with ES modules — no framework, no build step. Chrome loads the files directly.

---

## Setup

### 1. Get an Anthropic API key
1. Go to [console.anthropic.com](https://console.anthropic.com) → **API Keys**
2. Create a key (starts with `sk-ant-`). New accounts include **$5 free credit**.

### 2. Load the extension
1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked** and select the `DealScan/` folder

### 3. Add your key
1. Right-click the DealScan icon → **Options**
2. Paste your Anthropic key → **Save Settings**

---

## Usage

1. Open any `facebook.com/marketplace/item/...` listing
2. Click the floating **⚡ Evaluate Deal** button (or the toolbar icon)
3. Review the score, price range, and suggested offer
4. **Save** it to history or add it to your **Watchlist**

Always glance at the title and asking price shown in the panel — if those match the listing, the verdict is evaluating the right item.

---

## Privacy

Your API key is stored in `chrome.storage.local` — local to your browser, never synced or sent anywhere except the Anthropic API. Listing data is sent only to Anthropic for evaluation. History and watchlist live locally.
