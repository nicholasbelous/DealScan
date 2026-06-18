// DealScan options page — API keys, model choice, data export.

import { getSettings, saveSettings, getHistory, clearHistory } from "../shared/storage.js";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  // Load current settings into the form.
  const settings = await getSettings();
  $("anthropic-key").value = settings.anthropicKey;
  $("model").value = settings.model;
  $("analyze-images").checked = settings.analyzeImages === true;
  $("web-search").checked = settings.useWebSearch === true;

  $("btn-save").addEventListener("click", save);
  $("toggle-key").addEventListener("click", toggleKeyVisibility);
  $("btn-export").addEventListener("click", exportHistory);
  $("btn-clear").addEventListener("click", clearAllHistory);
});

async function save() {
  const key = $("anthropic-key").value.trim();
  const status = $("save-status");

  // Light validation — catch obvious paste mistakes, not exhaustive.
  if (key && !key.startsWith("sk-ant-")) {
    status.textContent = 'That doesn\'t look like an Anthropic key (should start with "sk-ant-").';
    status.classList.add("error");
    return;
  }

  await saveSettings({
    anthropicKey: key,
    model: $("model").value,
    analyzeImages: $("analyze-images").checked,
    useWebSearch: $("web-search").checked,
  });

  status.classList.remove("error");
  status.textContent = "✓ Saved";
  setTimeout(() => (status.textContent = ""), 2500);
}

function toggleKeyVisibility() {
  const input = $("anthropic-key");
  input.type = input.type === "password" ? "text" : "password";
}

async function exportHistory() {
  const history = await getHistory();
  const blob = new Blob([JSON.stringify(history, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `dealscan-history-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);

  $("data-status").textContent = `Exported ${history.length} evaluation${history.length === 1 ? "" : "s"}.`;
}

async function clearAllHistory() {
  const history = await getHistory();
  if (history.length === 0) {
    $("data-status").textContent = "History is already empty.";
    return;
  }
  if (!confirm(`Delete all ${history.length} saved evaluations? This can't be undone.`)) return;
  await clearHistory();
  $("data-status").textContent = "History cleared.";
}
