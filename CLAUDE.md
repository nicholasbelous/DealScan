# DealScan — Project Context for Claude

## What This Is
A Chrome extension (Manifest V3) that evaluates Facebook Marketplace listings using the Anthropic API. The user scrapes a listing, Claude analyzes it with web search, and the extension returns a deal score, price breakdown, red/green flags, and negotiation tips via a persistent side panel.

## v1 Scope — Keep It Focused
Build only what's listed here. Do not add features, dashboards, or abstractions beyond this:

- Scrape listing data from `facebook.com/marketplace/item/*`
- Send to Claude (with web search) and parse the structured response
- Display: deal score (0–100), verdict, price breakdown, flags, negotiation tips
- Save evaluations to local history
- Basic watchlist (store and view — no background polling or price-drop alerts)
- Options page for API key storage and history export
- eBay pricing is optional/secondary — not in the critical evaluation path

## What Was Explicitly Cut from v1
- Analytics dashboard (savings totals, category breakdown, win rate)
- Background watchlist polling / price-drop badge alerts (`alarms.js`)
- Separate popup UI — toolbar icon click opens the side panel directly
- Build/bundle step — plain vanilla JS, no bundler, no framework
- `shared/components/` folder — no component framework
- `shared/hooks/` folder — no React-style hooks

## Tech Decisions
- **No framework** — vanilla JS + ES modules throughout
- **No build step** — Chrome loads files directly; no webpack/esbuild
- **No external npm dependencies** — everything ships as plain JS
- **Storage** — `chrome.storage.local` only; no sync, no remote DB
- **API calls** — made from the service worker (background), never from content scripts
- **Side panel** is the primary UI; the toolbar icon opens it directly via `manifest.json`

## File Layout
```
src/background/   — service-worker.js (message router + Claude calls), ebay.js (optional)
src/content/      — scraper.js, injector.js (floating button), observer.js (SPA nav)
src/sidepanel/    — primary UI (Evaluate / History / Watchlist tabs)
src/options/      — API key input, history export
src/shared/       — claude.js, storage.js, parser.js, formatter.js, categories.js
tests/            — scraper.test.js, claude.test.js, parser.test.js
```

## Goals & Distribution
- Personal use first; eventually shared with friends for free (not sold)
- Target Chrome Web Store publication after v1 is stable
- Keep evaluations cheap (~$0.003–0.005 each via Anthropic API)

## Key Constraints
- Only activate on `facebook.com/marketplace/item/*`
- API keys stored in `chrome.storage.local` — never synced or sent anywhere except their respective APIs
- Must handle Facebook's SPA navigation (no full page reloads between listings)
