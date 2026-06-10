// DealScan observer — detects Facebook's SPA navigation between listings.
//
// FB never does a full page reload when you click from one listing to the
// next, so content scripts only run once. We watch for URL changes via a
// MutationObserver (cheapest reliable signal — FB mutates the DOM heavily on
// every navigation) and notify:
//   - injector.js, via a window event, to add/remove the floating button
//   - the side panel, via a runtime message, to re-scrape the new listing
// Classic script (no ES modules in content scripts).

(() => {
  if (window.__dealscanObserver) return;
  window.__dealscanObserver = true;

  let lastUrl = location.href;

  const observer = new MutationObserver(() => {
    // After an extension reload this script is orphaned and chrome.runtime
    // calls throw — stop observing entirely; the fresh script takes over
    // once the page is refreshed.
    if (!chrome.runtime?.id) {
      observer.disconnect();
      return;
    }

    if (location.href === lastUrl) return;
    lastUrl = location.href;

    // Local: let injector.js re-sync the floating button.
    window.dispatchEvent(new Event("dealscan:navigated"));

    // Remote: let the side panel know the listing changed. The panel may not
    // be open — swallow the "no receiver" error that throws in that case.
    try {
      chrome.runtime
        .sendMessage({ type: "LISTING_CHANGED", url: location.href })
        .catch(() => {});
    } catch {
      observer.disconnect();
    }
  });

  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
