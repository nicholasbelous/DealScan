// DealScan options page — API keys, model choice, data export.

import {
  getSettings,
  saveSettings,
  getHistory,
  clearHistory,
  getUsageLog,
  clearUsageLog,
} from "../shared/storage.js";

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
  $("btn-export-usage").addEventListener("click", exportUsageLog);
  $("btn-clear").addEventListener("click", clearAllHistory);

  $("version-label").textContent = `DealScan v${chrome.runtime.getManifest().version}`;
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

function downloadJson(name, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function exportHistory() {
  const history = await getHistory();
  downloadJson("dealscan-history", history);
  $("data-status").textContent = `Exported ${history.length} evaluation${history.length === 1 ? "" : "s"}.`;
}

async function exportUsageLog() {
  const log = await getUsageLog();
  downloadJson("dealscan-usage", log);
  $("data-status").textContent = `Exported ${log.length} usage record${log.length === 1 ? "" : "s"}.`;
}

async function clearAllHistory() {
  const history = await getHistory();
  const log = await getUsageLog();
  if (history.length === 0 && log.length === 0) {
    $("data-status").textContent = "History and usage log are already empty.";
    return;
  }
  if (!confirm(`Delete ${history.length} saved evaluations and ${log.length} usage records? This can't be undone.`)) return;
  await clearHistory();
  await clearUsageLog();
  $("data-status").textContent = "History and usage log cleared.";
}
