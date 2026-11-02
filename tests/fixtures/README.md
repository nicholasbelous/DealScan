# Listing page fixtures

Saved, sanitized listing pages for the scraper tests.

**Raw HTML must never be committed.** A saved Facebook page holds your session data, your name, and real people's details.

1. In Chrome, open a listing and save the page as HTML only, into `tests/fixtures/raw/` (gitignored).
2. Run the sanitizer. The ID is the one in that listing's URL:
   ```sh
   npm run fixture:sanitize -- tests/fixtures/raw/normal.html --item-id 1234567 --expect reliable
   ```
3. Read the whole result in `tests/fixtures/review/` (also gitignored), looking for anything real: names, places, prices, photos, and IDs.
4. Only then, move it to `tests/fixtures/` and commit it. `npm test` runs the scraper on every `.html` file there, and checks it for leaks again.
5. Delete the raw file when you're done.

Useful pages to capture: a normal listing, no photos, a "Free" price, a sold listing, and a page mid-navigation (`--expect rejected`).

The sanitizer replaces all text, IDs, URLs, and attributes, unless they're on its short list of Facebook's own labels. It stops without writing anything if its leak check finds a problem.
