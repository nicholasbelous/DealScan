# Changelog

## 1.3.0 (not yet published)

Compared with 1.2.1, the version on the Chrome Web Store. The theme of this release is trust: DealScan now refuses, and says why, when it can't be sure it read the right listing or when Claude's answer doesn't hold up.

### Fixed

- **A result could describe the wrong listing.** 1.2.1 evaluated any read that found a title and a price, even from page text not tied to the listing's ID, and a Marketplace page shows many listings at once. Its ID check also matched by substring, so listing 123 matched 1234. Now a read must be verified against the item ID in the page address, by exact match, or DealScan refuses it and makes no API call.
- **Moving to another listing during an evaluation could show the first listing's result on the second,** and Save would have stored it there. Results are now tied to the listing they were computed for, and a late answer for a listing you've left is discarded.
- **Listings priced "Free" couldn't be evaluated.** They're now read as a price of 0. Garbage text containing only a comma is no longer read as a price of 0.
- **Clicking the page's Evaluate Deal button did nothing when the side panel was already open.** It now starts the evaluation, or shows the result if one is already on screen for that listing.
- **The location could run into the text after it,** for example "Fakeville Condition Used - good", and that text was sent to Claude. The location is now read from its own element.
- **Photos could be missed.** When the page held more than one copy of a listing's data, photos came from the first copy found, which might have none or only the main photo. They now come from whichever copy of that exact listing lists the most.
- **Broken answers from Claude were quietly repaired and shown,** for example by clamping a score or swapping an inverted price range. They're now rejected, with one retry (see below).
- **"vs market" showed a percentage, such as "7% above", for an asking price inside the market range.** It now says "Within market range", and shows a percentage only outside the range.

### Added

- **Verification of listings reached by clicking inside Facebook.** These pages have no embedded listing data, so DealScan verifies the listing panel itself. It reads only the `product_id` parameter from the seller's links, and cross-checks the page title and the search result card. The result shows which method verified the read.
- **Checks on Claude's answer.** Code checks the score's range, the market range, the suggested offer, and that a Buy score doesn't go with a price more than 10% above the market range. An invalid answer gets one retry, and after a contradiction the retry tells Claude what contradicted. If that fails too, the panel says it couldn't trust the evaluation, a different message from a network or API error.
- **Seller-written text is marked as untrusted data in the prompt,** and Claude is told not to follow instructions inside it.
- **Cost tracking.** Each saved evaluation records the model, prompt version, tokens, time taken, and cost from Anthropic's published prices. History shows each entry's cost, plus the median, 90th percentile, and total across the last 500 billed evaluations, saved or not, including retries and rejected answers. The usage log can be exported from Options.
- **A local log of refused reads,** with time, reason, verification method, and item ID only. History shows the most common reasons, and Options can export it.
- **A notice when a result was made without photos,** saying why: photo analysis is off, the listing was reached by clicking (reload to include photos), no photos were found, or none could be downloaded.
- **Server mode, for developers.** The extension can send evaluations to a DealScan server you run on your own machine. The server holds the API key, records every evaluation, enforces a daily budget and a per-token rate limit, and reuses answers for identical content. Direct mode, with your own key, remains the default.

### Changed

- **Claude no longer chooses the verdict or recommendation.** Both are computed from the score, using the same score bands the prompt describes.
- **Try Again on a refused read reloads the page and reads it again, without evaluating.** In 1.2.1 it went straight to a new evaluation.
- **A cached result made without photos is replaced** when a later read of the same listing offers more photos.
- **The panel is always in one clearly named state:** not on Marketplace, reading, ready, evaluating, result, rejected, or error.

### Privacy and permissions

- **The seller's name is no longer read from the page.** 1.2.1 read it but didn't send or save it.
- **Removed** the unused `activeTab` permission.
- **Added** an optional permission for `http://localhost`. It's requested only if you turn on server mode.

### For developers

- Automated tests with Node's built-in test runner, including headless Chrome tests of the content scripts and the side panel, run in GitHub Actions on every push. No test calls the Anthropic API.
- An evaluation harness that compares Claude's price ranges with human labels. Against the real API it costs money, and it refuses to start without `--confirm-paid`.
- A sanitizer that turns a saved Facebook page into a fake test fixture, with a leak check and a human review step. Raw pages are never committed.
- Documentation in `docs/`: architecture, design decisions, a code map, and testing.
