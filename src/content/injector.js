// DealScan injector — adds the floating "Evaluate Deal" button to listing pages.
//
// Clicking the button asks the service worker to open the side panel; the
// panel then scrapes this tab and starts the evaluation automatically.
// Classic script (no ES modules in content scripts).

(() => {
  if (window.__dealscanInjector) return;
  window.__dealscanInjector = true;

  const BUTTON_ID = "dealscan-evaluate-btn";

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;

    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.textContent = "⚡ Evaluate Deal";
    // Inline styles so Facebook's CSS can't override or purge them.
    Object.assign(btn.style, {
      position: "fixed",
      bottom: "24px",
      right: "24px",
      zIndex: "999999",
      padding: "12px 20px",
      borderRadius: "24px",
      border: "none",
      background: "#1a7f37",
      color: "#fff",
      fontSize: "15px",
      fontWeight: "600",
      fontFamily: "system-ui, -apple-system, sans-serif",
      cursor: "pointer",
      boxShadow: "0 4px 14px rgba(0, 0, 0, 0.35)",
      transition: "transform 0.15s ease, background 0.15s ease",
    });
    btn.addEventListener("mouseenter", () => {
      btn.style.transform = "scale(1.05)";
      btn.style.background = "#1f9d45";
    });
    btn.addEventListener("mouseleave", () => {
      btn.style.transform = "scale(1)";
      btn.style.background = "#1a7f37";
    });

    btn.addEventListener("click", () => {
      btn.textContent = "⏳ Opening…";
      chrome.runtime.sendMessage({ type: "OPEN_SIDE_PANEL" }, () => {
        // Reset label whether it succeeded or the panel was already open.
        setTimeout(() => (btn.textContent = "⚡ Evaluate Deal"), 1500);
      });
    });

    document.body.appendChild(btn);
  }

  function removeButton() {
    document.getElementById(BUTTON_ID)?.remove();
  }

  function isListingPage() {
    return /\/marketplace\/item\//.test(location.pathname);
  }

  function sync() {
    if (isListingPage()) injectButton();
    else removeButton();
  }

  sync();

  // observer.js dispatches this when Facebook's SPA navigates to a new URL.
  window.addEventListener("dealscan:navigated", sync);
})();
