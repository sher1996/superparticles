// Shared helpers: API calls, formatting, header, SVG charts (no external libraries).
const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const eur = (v) => (v == null || isNaN(v) ? "–" : "€ " + Number(v).toFixed(2));
const pct = (v, signed = true) => (v == null ? "–" : (signed && v > 0 ? "+" : "") + Math.round(v * 100) + "%");
const int = (v) => (v == null ? "–" : Number(v).toLocaleString("nl-NL"));

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts });
  let body = null;
  try { body = await res.json(); } catch (e) { /* empty */ }
  if (!res.ok) throw new Error((body && body.detail) || `HTTP ${res.status}`);
  return body;
}

async function renderHeader(active) {
  const el = $("#header");
  el.innerHTML = `<div class="top-inner">
    <span class="brand">bol Opportunity Engine</span>
    <span id="mode" class="mode"></span>
    <nav class="main">
      <a href="/" class="${active === "today" ? "active" : ""}">Today</a>
      <a href="/history" class="${active === "history" ? "active" : ""}">History</a>
      <a href="/settings" class="${active === "settings" ? "active" : ""}">Settings &amp; runs</a>
    </nav>
    <span class="spacer"></span>
    <span id="runinfo" class="runinfo"></span>
    <button id="runbtn" class="primary">Run now</button>
  </div>`;
  $("#runbtn").onclick = async () => {
    try {
      await api("/api/run", { method: "POST" });
      $("#runbtn").disabled = true;
      $("#runinfo").textContent = "Run started…";
      pollRun();
    } catch (e) { alert(e.message); }
  };
  return refreshStatus();
}

let _status = null;
async function refreshStatus() {
  const s = await api("/api/status");
  _status = s;
  const mode = $("#mode");
  mode.textContent = s.mode === "live" ? "LIVE" : "DEMO";
  mode.className = "mode " + s.mode;
  mode.title = s.mode === "live"
    ? (s.simulated_sources.length ? "Live, but simulated: " + s.simulated_sources.join(", ") : "All data from your real accounts")
    : "Demo mode: simulated market data. Set ENGINE_MODE=live in .env to use your accounts.";
  const lr = s.last_run;
  let info = "No runs yet";
  if (lr) {
    const when = (lr.finished_at || lr.started_at || "").replace("T", " ").slice(0, 16);
    info = lr.status === "running" ? "Running…" : `Last run ${when} · ${lr.status}`;
    $("#runbtn").disabled = lr.status === "running";
    if (lr.status === "running") pollRun();
  }
  if (s.next_run) info += ` · next ${s.next_run.replace("T", " ").slice(0, 16)}`;
  $("#runinfo").textContent = info;
  return s;
}

let _polling = false;
function pollRun() {
  if (_polling) return;
  _polling = true;
  const tick = async () => {
    const s = await api("/api/status");
    if (s.last_run && s.last_run.status === "running") { setTimeout(tick, 1500); return; }
    _polling = false;
    await refreshStatus();
    if (typeof window.onRunFinished === "function") window.onRunFinished(s.last_run);
  };
  setTimeout(tick, 1200);
}

// ---- charts ----------------------------------------------------------------
// lineChart(el, labels, [{name, values, cls: "s1"|"sref"}], {height})
function lineChart(el, labels, series, opts = {}) {
  const W = Math.max(260, Math.round(el.clientWidth || 520)), H = opts.height || 170, L = 40, R = 8, T = 8, B = 22;
  const all = series.flatMap((s) => s.values.filter((v) => v != null));
  if (!labels.length || !all.length) { el.innerHTML = `<div class="empty" style="padding:16px">No data yet</div>`; return; }
  if (labels.length < 2) {
    el.innerHTML = `<div class="empty" style="padding:14px;font-size:13px">Only one day so far (${esc(labels[0])}: <b>${series.map((s) => int(s.values[0])).join(" / ")}</b>). This history grows with every daily run.</div>`;
    return;
  }
  const max = niceMax(Math.max(...all));
  const n = labels.length;
  const x = (i) => L + (n === 1 ? 0 : (i * (W - L - R)) / (n - 1));
  const y = (v) => T + (H - T - B) * (1 - v / max);
  const path = (vals) => {
    let d = "", pen = false;
    vals.forEach((v, i) => {
      if (v == null) { pen = false; return; }
      d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
      pen = true;
    });
    return d;
  };
  const ticks = [0, max / 2, max];
  const xt = [0, Math.floor((n - 1) / 2), n - 1];
  const legend = series.length > 1
    ? `<div class="legend">${series.map((s) => `<span><i class="sw ${s.cls === "sref" ? "ref" : ""}"></i>${esc(s.name)}</span>`).join("")}</div>`
    : "";
  el.innerHTML = `${legend}<div class="chart">
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(opts.label || "chart")}">
      <g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>
      <g class="axis">
        ${ticks.map((t) => `<text x="${L - 6}" y="${y(t) + 3}" text-anchor="end">${fmtShort(t)}</text>`).join("")}
        ${xt.map((i) => `<text x="${x(i)}" y="${H - 6}" text-anchor="${i === 0 ? "start" : i === n - 1 ? "end" : "middle"}">${esc(labels[i])}</text>`).join("")}
      </g>
      ${series.slice().reverse().map((s) => `<path class="${s.cls || "s1"}" d="${path(s.values)}"/>`).join("")}
      <line class="cross" y1="${T}" y2="${H - B}" x1="-10" x2="-10" style="display:none"/>
      ${series.map((s, k) => `<circle class="${s.cls === "sref" ? "dotref" : "dot1"}" r="4" cx="-10" cy="-10" data-k="${k}" style="display:none"/>`).join("")}
      <rect x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent" class="hit"/>
    </svg><div class="tooltip"></div></div>`;
  const svg = el.querySelector("svg"), tip = el.querySelector(".tooltip"), cross = el.querySelector(".cross");
  const dots = el.querySelectorAll("circle");
  const hit = el.querySelector(".hit");
  hit.addEventListener("mousemove", (ev) => {
    const pt = svg.getBoundingClientRect();
    const sx = ((ev.clientX - pt.left) / pt.width) * W;
    const i = Math.max(0, Math.min(n - 1, Math.round(((sx - L) / (W - L - R)) * (n - 1))));
    cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.style.display = "";
    dots.forEach((d) => {
      const v = series[+d.dataset.k].values[i];
      if (v == null) { d.style.display = "none"; return; }
      d.setAttribute("cx", x(i)); d.setAttribute("cy", y(v)); d.style.display = "";
    });
    tip.innerHTML = `<b>${esc(labels[i])}</b><br>` + series.map((s) => `${esc(s.name)}: <b>${int(s.values[i])}</b>`).join("<br>");
    tip.style.display = "block";
    const px = (x(i) / W) * pt.width;
    tip.style.left = Math.min(pt.width - tip.offsetWidth, Math.max(0, px + 10)) + "px";
    tip.style.top = "4px";
  });
  hit.addEventListener("mouseleave", () => { tip.style.display = "none"; cross.style.display = "none"; dots.forEach((d) => (d.style.display = "none")); });
}

function sparkline(values, w = 90, h = 22) {
  const v = (values || []).filter((x) => x != null);
  if (v.length < 2) return "";
  const max = Math.max(...v) || 1, min = Math.min(...v);
  const span = max - min || 1;
  const d = v.map((val, i) => `${i ? "L" : "M"}${((i / (v.length - 1)) * (w - 2) + 1).toFixed(1)} ${(h - 2 - ((val - min) / span) * (h - 4)).toFixed(1)}`).join("");
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path d="${d}"/></svg>`;
}

function niceMax(v) {
  if (v <= 0) return 1;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (v <= m * p) return m * p;
  return 10 * p;
}
function fmtShort(v) {
  if (v >= 1000) return (v / 1000).toFixed(v >= 10000 ? 0 : 1).replace(".0", "") + "k";
  return Math.round(v).toString();
}
