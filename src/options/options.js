// DealScan options page: direct or server mode, the API key or server URL and
// token, model, photo and web search options, and exporting or clearing local data.

import {
  getSettings,
  saveSettings,
  getHistory,
  clearHistory,
  getUsageLog,
  clearUsageLog,
  getGateRejections,
  clearGateRejections,
} from "../shared/storage.js";

const $ = (id) => document.getElementById(id);

document.addEventListener("DOMContentLoaded", async () => {
  // Load current settings into the form.
  const settings = await getSettings();
  $("mode").value = settings.mode;
  $("server-url").value = settings.serverUrl;
  $("server-token").value = settings.serverToken;
  $("anthropic-key").value = settings.anthropicKey;
  showModeFields();
  $("model").value = settings.model;
  $("analyze-images").checked = settings.analyzeImages === true;
  $("web-search").checked = settings.useWebSearch === true;

  $("mode").addEventListener("change", showModeFields);
  $("btn-save").addEventListener("click", save);
  $("toggle-key").addEventListener("click", toggleKeyVisibility);
  $("btn-export").addEventListener("click", exportHistory);
  $("btn-export-usage").addEventListener("click", exportUsageLog);
  $("btn-export-rejections").addEventListener("click", exportGateRejections);
  $("btn-clear").addEventListener("click", clearAllHistory);

  $("version-label").textContent = `DealScan v${chrome.runtime.getManifest().version}`;
});

function showModeFields() {
  const server = $("mode").value === "server";
  $("server-fields").classList.toggle("hidden", !server);
  $("key-card").classList.toggle("hidden", server);
}

// Only a server on this machine for now: optional_host_permissions in the manifest
// allows nothing else. Returns the origin, or null if the URL isn't acceptable.
function serverOrigin(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" && url.hostname === "localhost" ? url.origin : null;
  } catch {
    return null;
  }
}

async function save() {
  const key = $("anthropic-key").value.trim();
  const mode = $("mode").value;
  const serverUrl = $("server-url").value.trim();
  const status = $("save-status");
  const fail = (message) => {
    status.textContent = message;
    status.classList.add("error");
  };

  // Light validation — catch obvious paste mistakes, not exhaustive.
  if (key && !key.startsWith("sk-ant-")) {
    fail('That doesn\'t look like an Anthropic key (should start with "sk-ant-").');
    return;
  }

  if (mode === "server") {
    const origin = serverOrigin(serverUrl);
    if (!origin) {
      fail("The server URL must be on this machine, like http://localhost:3000.");
      return;
    }
    // Must run straight from the click, so nothing is awaited before it.
    const granted = await chrome.permissions.request({ origins: [`${origin}/*`] });
    if (!granted) {
      fail("DealScan needs permission to reach that server.");
      return;
    }
  }

  await saveSettings({
    mode,
    serverUrl,
    serverToken: $("server-token").value.trim(),
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

async function exportGateRejections() {
  const log = await getGateRejections();
  downloadJson("dealscan-read-rejections", log);
  $("data-status").textContent = `Exported ${log.length} read rejection${log.length === 1 ? "" : "s"}.`;
}

async function clearAllHistory() {
  const history = await getHistory();
  const logCount = (await getUsageLog()).length + (await getGateRejections()).length;
  if (history.length === 0 && logCount === 0) {
    $("data-status").textContent = "History and logs are already empty.";
    return;
  }
  if (!confirm(`Delete ${history.length} saved evaluations and ${logCount} log records? This can't be undone.`)) return;
  await clearHistory();
  await clearUsageLog();
  await clearGateRejections();
  $("data-status").textContent = "History and logs cleared.";
}
