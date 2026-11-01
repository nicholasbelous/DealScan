// The page holds no data until a token is entered. The token stays in memory
// and goes only in a header, never in a URL.

const $ = (id) => document.getElementById(id);

const usd = (n) => (n == null ? "—" : `$${n.toFixed(4)}`);
const ms = (n) => (n == null ? "—" : `${Math.round(n)} ms`);
const percent = (n) => (n == null ? "—" : `${(n * 100).toFixed(1)}%`);

function fill(table, rows) {
  const body = table.querySelector("tbody");
  body.replaceChildren(
    ...rows.map(([label, value]) => {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      const td = document.createElement("td");
      th.textContent = label;
      td.textContent = value;
      tr.append(th, td);
      return tr;
    })
  );
  table.hidden = rows.length === 0;
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("message").textContent = "Loading…";
  const res = await fetch(`/v1/stats?window=${encodeURIComponent($("window").value)}`, {
    headers: { authorization: `Bearer ${$("token").value}` },
  });
  const stats = await res.json();
  if (!res.ok) {
    $("message").textContent = stats.reason ?? "Couldn't load stats.";
    fill($("summary"), []);
    fill($("reasons"), []);
    $("reasons-heading").hidden = true;
    return;
  }

  $("message").textContent = "";
  fill($("summary"), [
    ["Evaluations", stats.total],
    ["Valid", stats.byStatus.valid],
    ["Rejected", stats.byStatus.rejected],
    ["Errors", stats.byStatus.error],
    ["Cost per evaluation, median", usd(stats.costUsd.median)],
    ["Cost per evaluation, p90", usd(stats.costUsd.p90)],
    ["Total cost", usd(stats.totalCostUsd)],
    ["Latency, median", ms(stats.latencyMs.median)],
    ["Latency, p90", ms(stats.latencyMs.p90)],
    ["Cache hit rate", percent(stats.cacheHitRate)],
  ]);
  fill($("reasons"), stats.topRejectionReasons.map((r) => [r.reason, r.count]));
  $("reasons-heading").hidden = stats.topRejectionReasons.length === 0;
});
