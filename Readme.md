# DealScan — Facebook Marketplace Deal Evaluator

> A Chrome extension that evaluates Facebook Marketplace listings using Claude AI. Get an instant deal score, market price estimate, red/green flag breakdown, and negotiation tips — all without leaving Facebook.

---

## Features

- **Auto-scrape** — extracts title, price, condition, description, images, and seller info from any listing
- **AI-powered analysis** — Claude researches the item via web search and returns a structured verdict (~15 seconds)
- **Deal score** — 0–100 score with a verdict: Great Deal / Good Deal / Fair / Overpriced / Avoid
- **Price breakdown** — asking price vs estimated market range vs suggested offer
- **Red & green flags** — scam signals, stock photos, vague descriptions, original packaging, motivated sellers, etc.
- **Negotiation tips** — specific talking points based on the listing's weaknesses
- **eBay pricing** — optional eBay Browse API integration for real sold-listings data
- **Deal history** — every saved evaluation stored locally with score, price, and verdict
- **Watchlist** — save listings to revisit later
- **Persistent side panel** — stays open while you browse; re-scrapes automatically on Facebook SPA navigation
- **Options page** — enter your Anthropic API key and optional eBay App ID; export history as JSON

---

## Project Structure

```
DealScan/
├── manifest.json                  # MV3 config — permissions, service worker, side panel
├── .env.example                   # ANTHROPIC_KEY, EBAY_APP_ID placeholders
│
├── src/
│   ├── background/
│   │   ├── service-worker.js      # Message router + Claude API calls
│   │   └── ebay.js                # Optional eBay Browse API — sold listings, avg price
│   │
│   ├── content/                   # Injected into facebook.com/marketplace/item/* tabs
│   │   ├── scraper.js             # Extracts title, price, condition, images, seller info
│   │   ├── injector.js            # Injects floating "Evaluate" button onto listing page
│   │   └── observer.js            # MutationObserver — re-scrapes on SPA navigation
│   │
│   ├── sidepanel/                 # Primary UI — stays open while browsing
│   │   ├── sidepanel.html         # Tabs: Evaluate / History / Watchlist
│   │   ├── sidepanel.js
│   │   └── sidepanel.css
│   │
│   ├── options/                   # Settings page (right-click extension → Options)
│   │   ├── options.html
│   │   ├── options.js             # API keys, data export
│   │   └── options.css
│   │
│   └── shared/                    # Shared modules across sidepanel, background, options
│       ├── claude.js              # Anthropic API wrapper — web search, vision, streaming
│       ├── storage.js             # chrome.storage wrapper — history, watchlist, settings
│       ├── parser.js              # Normalises scraped listing into clean schema
│       ├── formatter.js           # Currency, dates, score display helpers
│       └── categories.js         # Category detection + category-specific eval logic
│
├── assets/
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
└── tests/
    ├── scraper.test.js            # Validates scraper against sample FB pages
    ├── claude.test.js             # Mocked API response parsing
    └── parser.test.js             # Listing normalisation + category logic
```

---

## Setup

### 1. Get an Anthropic API Key
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up and navigate to **API Keys**
3. Create a new key — it starts with `sk-ant-`
4. New accounts receive **$5 free credit** (~1,000–1,500 evaluations)

### 2. Get an eBay App ID (optional)
1. Go to [developer.ebay.com](https://developer.ebay.com)
2. Register a free app and copy your **App ID (Client ID)** from the production keyset
3. Without this, pricing relies on Claude's web search only

### 3. Install the Extension in Chrome
1. Open Chrome → `chrome://extensions/`
2. Enable **Developer Mode** (top-right toggle)
3. Click **Load unpacked** → select the `DealScan/` folder
4. The DealScan icon appears in your toolbar — pin it for easy access

### 4. Add Your API Keys
1. Right-click the extension icon → **Options**
2. Enter your Anthropic API key and (optionally) your eBay App ID
3. Click **Save** — keys are stored locally in `chrome.storage.local`, never synced or shared

---

## Usage

### Evaluating a Listing
1. Navigate to any `facebook.com/marketplace/item/...` page
2. Click the floating **"Evaluate Deal"** button injected on the page, or click the extension icon in the toolbar to open the side panel
3. The panel evaluates the listing — takes ~15 seconds
4. Review the score, price breakdown, flags, and negotiation tips
5. Hit **Save** to add it to your history, or **Add to Watchlist** to revisit later

### Exporting Data
- Go to **Options → Export History** to download your full deal history as JSON

---

## Cost

Each evaluation makes one Anthropic API call with web search enabled.

| Usage | Approx. cost |
|---|---|
| Per evaluation | ~$0.003–$0.005 |
| 100 evaluations | ~$0.30–$0.50 |
| $5 free credit | ~1,000–1,500 evaluations |

---

## Notes

- API keys live in `chrome.storage.local` — local to your browser only
- The extension only activates on `facebook.com/marketplace/item/*` URLs
- Facebook occasionally changes their page structure; if scraping fails, refresh the listing and try again
- No build step required — plain JS loaded directly by Chrome (MV3 + ES modules)
