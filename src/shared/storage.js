// chrome.storage.local wrapper for DealScan.
//
// Single source of truth for everything we persist: user settings (API keys,
// model choice), saved deal history, and the watchlist. Keeping all reads and
// writes here means the rest of the extension never touches chrome.storage
// keys directly.

const KEYS = {
  settings: "settings",
  history: "history",
  watchlist: "watchlist",
};

const DEFAULT_SETTINGS = {
  anthropicKey: "",
  ebayAppId: "",
  model: "claude-haiku-4-5",
};

// --- Settings ----------------------------------------------------------------

export async function getSettings() {
  const stored = await get(KEYS.settings);
  return { ...DEFAULT_SETTINGS, ...(stored || {}) };
}

export async function saveSettings(partial) {
  const current = await getSettings();
  const next = { ...current, ...partial };
  await set(KEYS.settings, next);
  return next;
}

// --- History -----------------------------------------------------------------

export async function getHistory() {
  return (await get(KEYS.history)) || [];
}

export async function addToHistory(entry) {
  const history = await getHistory();
  // Prepend newest-first; stamp an id + timestamp for sorting/dedup.
  const record = { id: crypto.randomUUID(), savedAt: Date.now(), ...entry };
  history.unshift(record);
  await set(KEYS.history, history);
  return record;
}

export async function removeFromHistory(id) {
  const history = await getHistory();
  await set(KEYS.history, history.filter((h) => h.id !== id));
}

export async function clearHistory() {
  await set(KEYS.history, []);
}

// --- Watchlist ---------------------------------------------------------------

export async function getWatchlist() {
  return (await get(KEYS.watchlist)) || [];
}

export async function addToWatchlist(entry) {
  const watchlist = await getWatchlist();
  // Dedup by listing URL so re-adding the same item updates it in place.
  const without = watchlist.filter((w) => w.url !== entry.url);
  const record = { id: crypto.randomUUID(), addedAt: Date.now(), ...entry };
  without.unshift(record);
  await set(KEYS.watchlist, without);
  return record;
}

export async function removeFromWatchlist(id) {
  const watchlist = await getWatchlist();
  await set(KEYS.watchlist, watchlist.filter((w) => w.id !== id));
}

// --- Low-level chrome.storage.local helpers ----------------------------------

function get(key) {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (res) => resolve(res[key]));
  });
}

function set(key, value) {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, resolve);
  });
}
