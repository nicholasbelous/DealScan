// Field extraction: condition, location, description, and vehicle facts. Each
// takes the container to read from, so a verified panel reads only itself.
// Classic script (no ES modules in content scripts): shares window.__dealscan.

(() => {
  window.__dealscan ??= {};
  const { PRICE_RE, searchRoots } = window.__dealscan;

  function labeledValueDom(label, scope) {
    for (const root of scope ? [scope] : searchRoots()) {
      for (const el of root.querySelectorAll("span, div")) {
        const t = el.textContent?.trim() ?? "";
        if (
          el.childElementCount <= 2 &&
          t.startsWith(label) &&
          t.length < 80 &&
          t.length > label.length
        ) {
          return t.slice(label.length).replace(/^[\s:·–-]+/, "").trim() || null;
        }
      }
    }
    return null;
  }

  function locationFromDom(scope = document.body) {
    const m = scope.textContent.match(/Listed[^·\n]*?\bin\s+([A-Z][\w\s.,'-]{2,40})/);
    return m ? m[1].trim() : null;
  }

  function longestDetailText(
    scope = document.querySelector('div[role="main"]') || document.body
  ) {
    let best = null;
    for (const el of scope.querySelectorAll("span, div")) {
      if (el.childElementCount > 0) continue;
      const t = el.textContent?.trim() ?? "";
      if (t.length < 50) continue;
      if (PRICE_RE.test(t) && t.length < 60) continue;
      if (!best || t.length > best.length) best = t;
    }
    return best;
  }

  // === Vehicle / structured attributes =======================================
  // Only facts we can extract RELIABLY: year (from the title) and mileage
  // (from FB's "Driven X miles", anchored to the title's own container so a
  // neighboring listing's mileage can't leak in). Anything we can't pin down
  // is left out — Claude reads the rest from the description, and an absent
  // value is reported honestly rather than guessed.
  function extractAttributes(title, titleEl) {
    const attrs = {};

    const yearMatch = title && title.match(/\b(19[5-9]\d|20[0-4]\d)\b/);
    if (yearMatch) attrs.year = yearMatch[1];

    const mileage = extractMileage(titleEl);
    if (mileage) attrs.mileage = mileage;

    return Object.keys(attrs).length > 0 ? attrs : null;
  }

  function extractMileage(titleEl) {
    // Anchor to the smallest ancestor of the title that mentions mileage —
    // that ancestor is the open listing's detail pane, never a sidebar item.
    const re = /Driven\s+([\d.,]{2,})\s*(miles|mi|km)\b/i;
    const scope = titleEl ? nearestScopeWithText(titleEl, re) : null;
    if (!scope) return null;
    const m = scope.textContent.match(re);
    if (!m) return null;
    const n = Number(m[1].replace(/[.,]/g, ""));
    if (!Number.isFinite(n) || n < 100) return null; // reject noise
    return `${n.toLocaleString("en-US")} ${/km/i.test(m[2]) ? "km" : "miles"}`;
  }

  function nearestScopeWithText(el, re) {
    let scope = el.parentElement;
    for (let i = 0; i < 8 && scope; i += 1, scope = scope.parentElement) {
      if (re.test(scope.textContent || "")) return scope;
    }
    return null;
  }

  Object.assign(window.__dealscan, { labeledValueDom, locationFromDom, longestDetailText, extractAttributes });
})();
