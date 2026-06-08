# Marketplace Deal Evaluator

> A Chrome extension that evaluates Facebook Marketplace listings using Claude AI. Get a real-time deal score, market price comparison, red flag detection, negotiation tips, and a persistent watchlist — all without leaving Facebook.

---

## Features

### Core Evaluation
- **Auto-scrape** — extracts title, price, condition, description, images, and seller info from any listing automatically
- **AI-powered analysis** — Claude researches the item using built-in web search and returns a structured verdict in ~15 seconds
- **eBay sold listings** — pulls real completed sales data via the eBay Browse API for hard price evidence
- **Deal score** — 0–100 score with a verdict: Great Deal / Good Deal / Fair / Overpriced / Avoid
- **Price breakdown** — asking price vs retail new vs used market range vs suggested offer
- **Savings calculator** — shows % below or above market value

### Smart Detection
- **Red flag detection** — scam signals, stock photos, vague descriptions, suspiciously low prices
- **Green flag detection** — original packaging, receipts, motivated sellers, detailed descriptions
- **Category-specific logic** — cars get mileage/year analysis, electronics get model generation checks, furniture gets brand tier scoring
- **Demand level** — high / medium / low demand rating affects how hard you should negotiate

### Negotiation
- **Tailored tips** — Claude generates specific talking points based on the listing's weaknesses
- **Suggested offer** — calculated bid price based on condition, demand, and market data
- **Recommendation** — clear Buy / Negotiate / Pass call

### Persistent Side Panel
- **Stays open** while you browse — unlike a popup, the side panel doesn't close when you click away
- **Floating button** — injected directly onto the listing page so you never need to open the extension manually
- **SPA-aware** — re-scrapes automatically when Facebook navigates to a new listing without a full page reload

### History & Watchlist
- **Deal history** — every saved evaluation stored locally with score, prices, and verdict
- **Sortable & searchable** — filter history by category, verdict, or date
- **Watchlist** — save listings to monitor; get notified when the price drops
- **Price-drop alerts** — background scheduler checks watchlist items and badges the extension icon

### Analytics
- **Savings dashboard** — total saved vs market across all purchases
- **Category breakdown** — which categories you find the best deals in
- **Deal track record** — win rate over time

### Export & Sharing
- **Copy report** — full plain-text deal report to clipboard
- **Data export** — export full history as JSON from the Options page

---

## Project Structure

```
marketplace-evaluator/
├── manifest.json                        # MV3 config — permissions, service worker, side panel
├── .env.example                         # ANTHROPIC_KEY, EBAY_APP_ID placeholders
├── README.md
│
├── src/
│   ├── background/                      # Service worker — runs always-on
│   │   ├── service-worker.js            # Message router, installs alarms, manages cache
│   │   ├── ebay.js                      # eBay Browse API — sold listings, avg price calc
│   │   ├── cache.js                     # Price cache with 1hr TTL (chrome.storage)
│   │   └── alarms.js                    # Watchlist price-check scheduler (chrome.alarms)
│   │
│   ├── content/                         # Injected into FB Marketplace tabs
│   │   ├── scraper.js                   # Extracts title, price, condition, images, seller info
│   │   ├── injector.js                  # Injects floating "Evaluate" button onto listing page
│   │   └── observer.js                  # MutationObserver — re-scrapes on SPA navigation
│   │
│   ├── popup/                           # Toolbar icon click → quick verdict
│   │   ├── popup.html
│   │   ├── popup.js                     # Triggers scrape, renders verdict + quick price breakdown
│   │   └── popup.css
│   │
│   ├── sidepanel/                       # Full persistent panel — stays open while browsing
│   │   ├── sidepanel.html               # Tabs: Evaluate / History / Watchlist / Analytics
│   │   ├── sidepanel.js                 # Full evaluation flow, charts, history, watchlist mgmt
│   │   └── sidepanel.css               # Rich UI — price charts, score rings, animated verdicts
│   │
│   ├── options/                         # Settings page (right-click extension → Options)
│   │   ├── options.html
│   │   ├── options.js                   # API keys, alert thresholds, category presets, data export
│   │   └── options.css
│   │
│   └── shared/                          # Reusable across popup, sidepanel, background
│       ├── components/
│       │   ├── verdict-card.js          # Score ring + rating badge + headline
│       │   ├── price-chart.js           # Sparkline: asking vs market range over time
│       │   ├── flag-list.js             # Red/green flag renderer with icons
│       │   ├── deal-score.js            # Animated SVG score ring (0–100)
│       │   ├── history-table.js         # Sortable deal history with filters
│       │   └── watchlist.js             # Saved items + price-drop alert badges
│       │
│       ├── utils/
│       │   ├── claude.js                # Anthropic API wrapper — web search, vision, streaming
│       │   ├── storage.js               # chrome.storage wrapper — history, watchlist, settings
│       │   ├── parser.js                # Normalises scraped listing into clean schema
│       │   ├── pricing.js               # Market price aggregation, depreciation curves
│       │   ├── formatter.js             # Currency, dates, score display helpers
│       │   └── categories.js            # Category detection + category-specific eval logic
│       │
│       └── hooks/
│           ├── useHistory.js            # CRUD + search for deal history
│           ├── useWatchlist.js          # Add/remove/check watchlist items
│           └── useAlerts.js             # Subscribe to price-drop notifications
│
├── assets/
│   └── icons/
│       ├── icon16.png
│       ├── icon48.png
│       └── icon128.png
│
├── scripts/
│   ├── build.js                         # Bundles + minifies for Chrome Web Store submission
│   └── package.js                       # Zips dist/ folder for upload
│
└── tests/
    ├── scraper.test.js                  # Validates scraper against sample FB pages
    ├── claude.test.js                   # Mocked API response parsing
    └── pricing.test.js                  # eBay aggregation + depreciation logic
```

---

## Setup

### 1. Get an Anthropic API Key
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Sign up and navigate to **API Keys**
3. Create a new key — it starts with `sk-ant-`
4. New accounts receive **$5 free credit** (~1,500 evaluations)

### 2. Get an eBay App ID (optional but recommended)
1. Go to [developer.ebay.com](https://developer.ebay.com)
2. Create a free account and register a new app
3. Copy your **App ID (Client ID)** from the production keyset
4. Without this, pricing falls back to Claude's web search only

### 3. Create the Project

```bash
mkdir -p marketplace-evaluator && cd marketplace-evaluator

mkdir -p src/{background,content,popup,options,sidepanel,shared/{components,utils,hooks}} assets/{icons,fonts} scripts tests

touch manifest.json README.md .env.example \
  src/background/{service-worker.js,cache.js,alarms.js,ebay.js} \
  src/content/{scraper.js,injector.js,observer.js} \
  src/popup/{popup.html,popup.js,popup.css} \
  src/options/{options.html,options.js,options.css} \
  src/sidepanel/{sidepanel.html,sidepanel.js,sidepanel.css} \
  src/shared/components/{verdict-card.js,price-chart.js,flag-list.js,history-table.js,watchlist.js,deal-score.js} \
  src/shared/utils/{claude.js,storage.js,parser.js,pricing.js,formatter.js,categories.js} \
  src/shared/hooks/{useHistory.js,useWatchlist.js,useAlerts.js} \
  assets/icons/{icon16.png,icon48.png,icon128.png} \
  scripts/{build.js,package.js} \
  tests/{scraper.test.js,claude.test.js,pricing.test.js}
```

### 4. Configure Environment

Copy `.env.example` to `.env` and fill in your keys:

```
ANTHROPIC_KEY=sk-ant-...
EBAY_APP_ID=YourApp-...
```

### 5. Install the Extension in Chrome
1. Open Chrome and go to `chrome://extensions/`
2. Enable **Developer Mode** (toggle in the top right)
3. Click **Load unpacked**
4. Select the `marketplace-evaluator/` folder
5. The extension icon appears in your toolbar — pin it for easy access

### 6. Add Your API Keys in the Extension
1. Right-click the extension icon → **Options**
2. Enter your Anthropic API key and (optionally) your eBay App ID
3. Click Save — keys are stored locally in Chrome and never sent anywhere except their respective APIs

---

## Usage

### Evaluating a Listing
1. Navigate to any `facebook.com/marketplace/item/...` page
2. Click the floating **"Evaluate Deal"** button injected onto the page, or click the extension icon in the toolbar
3. The side panel opens and begins evaluating — takes ~15 seconds
4. Review the verdict, price breakdown, flags, and negotiation tips
5. Hit **Save** to add it to your history, or **Add to Watchlist** to monitor the price

### Watchlist Alerts
- Items saved to the watchlist are checked automatically every few hours in the background
- If the price drops, the extension icon shows a badge and the side panel highlights the change

### Exporting Data
- Go to **Options → Data → Export History** to download your full deal history as JSON

---

## Cost

Each evaluation makes one call to the Anthropic API with web search enabled.

| Usage | Approx. cost |
|---|---|
| Per evaluation | ~$0.003–$0.005 |
| 100 evaluations | ~$0.30–$0.50 |
| $5 free credit | ~1,000–1,500 evaluations |

For personal use you will likely never exhaust the free credit.

---

## Notes

- Your API keys are stored in `chrome.storage.local` — local to your browser, never synced or shared
- Facebook occasionally changes their page structure; if scraping fails, refresh the listing and try again
- The extension only activates on `facebook.com/marketplace/item/*` URLs
- eBay pricing data is cached for 1 hour to avoid redundant API calls
- The side panel is the primary UI — use the popup only for a quick verdict when the panel isn't open