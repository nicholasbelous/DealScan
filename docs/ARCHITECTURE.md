# Architecture

DealScan reads a Facebook Marketplace listing, asks Claude to evaluate it, and shows the result in Chrome's side panel. Two things in that path can be wrong: the page read and the model's answer. The design puts one explicit check on each, and refuses rather than guesses when a check fails.

For each file's role see [CODEMAP.md](CODEMAP.md). For why it's built this way see [DECISIONS.md](DECISIONS.md).

## System overview

```mermaid
flowchart TB
  subgraph tab["Facebook tab"]
    CS["Content scripts<br/>scraper and its sources,<br/>injector (button), observer (navigation)<br/>share window.__dealscan"]
  end

  subgraph ext["Extension"]
    SP["Side panel<br/>sidepanel.js + panel-state, gate, parser"]
    SW["Service worker<br/>service-worker.js"]
    OPT["Options page"]
    subgraph storage["Extension storage"]
      LOCAL[("chrome.storage.local<br/>settings, saved history,<br/>usage log, read rejection log")]
      SESSION[("chrome.storage.session<br/>one-hour result cache,<br/>page button flag")]
    end
  end

  subgraph server["DealScan server (optional, localhost only)"]
    APP["Fastify app"]
    DB[("SQLite")]
  end
  API["api.anthropic.com"]
  FBCDN["fbcdn.net<br/>listing photos"]

  CS -- "OPEN_SIDE_PANEL" --> SW
  CS -- "LISTING_CHANGED" --> SP
  SP -- "SCRAPE_LISTING" --> CS
  SP -- "EVALUATE_LISTING" --> SW
  SW -- "server mode" --> APP
  SW -- "direct mode" --> API
  SW -- "photos" --> FBCDN
  APP --> API
  APP --> DB
  OPT --> LOCAL
  SP --> storage
  SW --> storage
```

The content scripts only read the page and never make network calls. The side panel asks them for a read, decides whether it can be trusted, and then hands the listing to the service worker, which is the only part that makes network requests. It downloads photos, then calls Anthropic directly with the user's key (direct mode, the default) or a DealScan server running on the same machine (server mode). If a tab has no content scripts yet, for example because it was open before the extension loaded, the panel injects them with `chrome.scripting`.

## One evaluation, from click to result

```mermaid
sequenceDiagram
  actor User
  participant Page as Content scripts
  participant SW as Service worker
  participant Panel as Side panel
  participant CDN as fbcdn.net
  participant API as Anthropic API

  User->>Page: Click "Evaluate Deal"
  Page->>SW: OPEN_SIDE_PANEL
  SW->>SW: Set pendingEvaluate in session storage, open the panel
  Note over Panel: Reads the flag on load, or through<br/>storage.onChanged if already open
  Panel->>Panel: evaluateIfRequested(): flag is for this tab

  loop Up to 6 reads, 450 ms apart, stopping at the first that passes the gate
    Panel->>Page: SCRAPE_LISTING
    Page-->>Panel: Raw read: fields, verified item ID, method
  end
  Panel->>Panel: parseListing() runs the gate, checkRead()

  alt Refusal point 1: the gate refuses the read
    Panel->>Panel: Log reason, method, and item ID locally<br/>State "rejected". No API call
  else The read is verified
    Panel->>SW: EVALUATE_LISTING
    alt Result for this URL from the last hour, unless it had no photos and this read offers more
      SW-->>Panel: Cached result, no API call
    else
      SW->>CDN: Download up to 3 photos
      CDN-->>SW: Photos (failures are skipped)
      loop At most 2 attempts
        SW->>API: Messages request, seller text inside untrusted_listing tags
        API-->>SW: Answer
        SW->>SW: readVerdict() validates it
      end
      alt Refusal point 2: invalid twice, or Claude declined
        SW-->>Panel: Rejected, with the reason
        Panel->>Panel: State "rejected". The attempts were billed
      else Valid
        SW->>SW: finalizeVerdict(): label, recommendation,<br/>savings, offer cap computed in code
        SW->>SW: Log usage, cache the result
        SW-->>Panel: Result
        Panel->>Panel: Shown only if the user hasn't moved on (run number)
      end
    end
  end
```

There are two refusal points. The gate (`src/shared/gate.js`) refuses a read unless a source tied to the URL's item ID supplied the title and price. Validation (`src/shared/verdict.js`) refuses an answer that fails the schema or contradicts the price, after one retry. Every evaluation that reached the API gets one record in the local usage log, with the tokens and cost of all its attempts, whether it ended valid, rejected, or failed. In server mode the service worker sends the listing and photos to `POST /v1/evaluate` instead, and the server runs the same `runEvaluation()` from `src/shared/anthropic.js`. Opening the panel from the toolbar icon, or moving to another listing, only previews: it reads and shows **Evaluate This Listing**, and nothing is sent until a click.

## The side panel state machine

```mermaid
stateDiagram-v2
  [*] --> not_marketplace
  not_marketplace --> reading: navigated to a listing
  reading --> ready: read-finished, gate passed
  reading --> rejected: read-finished, gate refused or item changed
  reading --> error: read-failed
  ready --> reading: read-started (Evaluate re-reads first)
  ready --> evaluating: evaluate-started
  evaluating --> result: evaluated
  evaluating --> rejected: answer-rejected
  evaluating --> error: evaluation-failed
  rejected --> reading: read-started (Try Again reloads the tab)
  error --> reading: read-started (Try Again evaluates again)

  note right of reading
    From any state, navigating to a different listing
    or starting a read moves here and starts a new run.
    Navigating off Marketplace goes to not_marketplace.
  end note
```

`src/shared/panel-state.js` is a pure reducer, and the panel draws only what it says. Every read and evaluation belongs to a run number. Navigation and new reads start a new run, and any event that finishes an older run is ignored, so a slow answer for listing A can't appear on listing B. `rejected` means DealScan chose not to trust something, and `error` means something failed: they show different messages.

## Server request path

```mermaid
flowchart TD
  REQ["POST /v1/evaluate"] --> AUTH{"Valid, unrevoked Bearer token?<br/>onRequest hook"}
  AUTH -- no --> E401["401 unauthorized"]
  AUTH -- yes --> RL{"Within this token's rate limit?<br/>preParsing hook"}
  RL -- no --> E429["429 rate_limited"]
  RL -- yes --> SCHEMA{"Body matches the schema?<br/>no unknown fields, no type coercion"}
  SCHEMA -- no --> E400["400 invalid_request<br/>or 413 too_large"]
  SCHEMA -- yes --> HASH["contentHash(listing, photos)<br/>store the listing row"]
  HASH --> CACHE{"Valid answer for the same item ID, hash,<br/>model, and prompt version within the TTL?"}
  CACHE -- yes --> HIT["Record a cache hit, cost 0<br/>200 valid"]
  CACHE -- no --> BUDGET{"Spent today, UTC, below DAILY_BUDGET_USD?"}
  BUDGET -- no --> EB["Record an error<br/>429 budget_exceeded"]
  BUDGET -- yes --> RUN["runEvaluation(): Anthropic call,<br/>validation, one retry"]
  RUN -- valid --> OK["Record valid<br/>200 valid"]
  RUN -- "invalid twice, or declined" --> REJ["Record rejected<br/>422 invalid_model_output"]
  RUN -- "API or network failure" --> UP["Record an error<br/>502 upstream_error"]
```

Auth runs before the body is parsed, and the rate limit runs after auth, so a bad token can't use up a real token's limit. The cache is checked before the budget because a hit costs nothing. Every outcome after the schema check writes a row to `evaluations`, including cache hits, budget refusals, and failures, with whatever the attempts cost. That table is what `GET /v1/stats` aggregates. The budget is checked before each call, not reserved, so requests already in flight can take spending past the cap. `/healthz` and the stats page's static files (`/stats`, `/stats.js`, `/stats.css`) need no token.

## Database schema

```mermaid
erDiagram
  tokens ||--o{ evaluations : "token_id, foreign key"
  listings ||--o{ evaluations : "item_id + content_hash, not enforced"
  labels |o--o{ listings : "item_id, not enforced"

  tokens {
    INTEGER id PK
    TEXT name
    TEXT token_hash UK "SHA-256 of the token"
    INTEGER created_at
    INTEGER revoked_at "null while active"
  }
  listings {
    TEXT item_id PK
    TEXT content_hash PK
    TEXT title
    REAL price
    TEXT condition
    TEXT category
    TEXT description
    INTEGER first_seen_at
  }
  evaluations {
    INTEGER id PK
    INTEGER token_id FK
    TEXT item_id
    TEXT content_hash
    TEXT model
    TEXT prompt_version
    TEXT status "valid, rejected, or error"
    TEXT rejection_reason
    INTEGER score
    TEXT verdict
    REAL price_low
    REAL price_high
    REAL suggested_offer
    TEXT raw_response "finalized verdict as JSON"
    INTEGER input_tokens
    INTEGER output_tokens
    INTEGER attempts
    REAL cost_usd "null for a budget refusal, when nothing was called"
    INTEGER latency_ms
    INTEGER cache_hit
    INTEGER created_at
  }
  labels {
    TEXT item_id PK
    TEXT title
    REAL human_price_low
    REAL human_price_high
    INTEGER readable
    TEXT notes
    INTEGER labeled_at
  }
  schema_migrations {
    TEXT name PK
    INTEGER applied_at
  }
```

The tables are created by the numbered files in `server/migrations/`, applied in order on startup and recorded in `schema_migrations`. There is no column for seller names, profile links, page HTML, or photos. Only `evaluations.token_id` is a declared foreign key. The other links are joins the code makes: the cache looks up `evaluations` by item ID and content hash, and the eval harness joins `labels` to the newest `listings` row for each item ID. Despite its name, `raw_response` holds the finalized verdict that was returned, not the model's raw text. The cache serves its answers from that column.
