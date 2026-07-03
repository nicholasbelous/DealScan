// chrome.storage.local wrapper for DealScan.
//
// Single source of truth for everything we persist: user settings (API keys,
// model choice) and saved deal history. Keeping all reads and writes here means
// the rest of the extension never touches chrome.storage keys directly.

const KEYS = {
  settings: "settings",
  history: "history",
};

const DEFAULT_SETTINGS = {
  anthropicKey: "",
  model: "claude-haiku-4-5",
  // Web search adds ~10x cost per evaluation (flat per-search fee + thousands
  // of result tokens). Off by default; opt in via Options for big purchases.
  useWebSearch: false,
  // Send 2-3 listing photos to Claude for condition + stock-photo detection.
  // Small cost bump (~0.3-0.5c/scan); on by default per user preference.
  analyzeImages: true,
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
  // Dedup by listing URL: re-saving the same listing replaces the old entry
  // (with the fresh verdict) rather than piling up duplicates.
  const without = entry.url ? history.filter((h) => h.url !== entry.url) : history;
  const record = { id: crypto.randomUUID(), savedAt: Date.now(), ...entry };
  without.unshift(record);
  await set(KEYS.history, without);
  return record;
}

export async function isInHistory(url) {
  if (!url) return false;
  const history = await getHistory();
  return history.some((h) => h.url === url);
}

export async function removeFromHistory(id) {
  const history = await getHistory();
  await set(KEYS.history, history.filter((h) => h.id !== id));
}

export async function clearHistory() {
  await set(KEYS.history, []);
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
