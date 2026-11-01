// Reading the labels CSV. Pure: takes text, returns rows or says what's wrong.

const COLUMNS = ["item_id", "title", "my_price_low", "my_price_high", "readable", "notes"];

/** Minimal CSV: quoted fields, doubled quotes, commas and newlines in quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const endField = () => {
    row.push(field);
    field = "";
  };
  const endRow = () => {
    endField();
    if (row.some((value) => value !== "")) rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") endField();
    else if (ch === "\n") endRow();
    else if (ch !== "\r") field += ch;
  }
  endRow();
  return rows;
}

/** @returns {{labels: object[], errors: string[]}} errors name the line. */
export function parseLabels(text) {
  const [header, ...rows] = parseCsv(text);
  if (header?.join(",") !== COLUMNS.join(",")) {
    return { labels: [], errors: [`The header must be: ${COLUMNS.join(",")}`] };
  }

  const labels = [];
  const errors = [];
  const seen = new Set();
  rows.forEach((values, index) => {
    const line = index + 2;
    const fail = (message) => errors.push(`Line ${line}: ${message}`);
    const [itemId, title, low, high, readable, notes] = values;

    if (values.length !== COLUMNS.length) return fail(`expected ${COLUMNS.length} columns, got ${values.length}`);
    if (!/^\d+$/.test(itemId)) return fail(`item_id must be digits, got "${itemId}"`);
    if (seen.has(itemId)) return fail(`duplicate item_id ${itemId}`);
    seen.add(itemId);
    if (!["true", "false"].includes(readable)) return fail(`readable must be true or false, got "${readable}"`);

    const isReadable = readable === "true";
    const priceLow = low === "" ? null : Number(low);
    const priceHigh = high === "" ? null : Number(high);
    if (isReadable) {
      if (!Number.isFinite(priceLow) || !Number.isFinite(priceHigh) || priceLow === null || priceHigh === null) {
        return fail("a readable listing needs numeric my_price_low and my_price_high");
      }
      if (priceLow < 0 || priceLow > priceHigh) return fail("my_price_low must be from 0 up to my_price_high");
    }

    labels.push({ itemId, title, priceLow, priceHigh, readable: isReadable, notes: notes || null });
  });
  return { labels, errors };
}

export function saveLabels(db, labels, now = Date.now()) {
  const upsert = db.prepare(
    `INSERT INTO labels (item_id, title, human_price_low, human_price_high, readable, notes, labeled_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET
       title = excluded.title,
       human_price_low = excluded.human_price_low,
       human_price_high = excluded.human_price_high,
       readable = excluded.readable,
       notes = excluded.notes,
       labeled_at = excluded.labeled_at`
  );
  db.transaction(() => {
    for (const l of labels) upsert.run(l.itemId, l.title, l.priceLow, l.priceHigh, l.readable ? 1 : 0, l.notes, now);
  })();
}
