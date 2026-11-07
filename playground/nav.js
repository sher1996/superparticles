// Shared shell for every playground page: brand header, page menu, collapsible panel
// and filled slider tracks. Load it before the page's own script:
//   <script type="module" src="./nav.js"></script>
// Canvas pages keep their controls in <aside id="panel">; document pages get a top bar.

export const PAGES = [
  {
    group: "Particles",
    items: [
      { href: "index.html", icon: "✦", title: "Particle playground", desc: "The engine: renderers, plugins and a learned swarm" },
      { href: "bench.html", icon: "◷", title: "Benchmark", desc: "Measure frame rate and NCA speed on this device" },
    ],
  },
  {
    group: "Smart Particles · neural cellular automata",
    items: [
      { href: "smart.html", icon: "❖", title: "Grow & heal", desc: "Cells grow a shape from one seed and repair damage" },
      { href: "train.html", icon: "✎", title: "Teach a shape", desc: "Draw something and train your own model in the browser" },
      { href: "swarm.html", icon: "⁂", title: "Moving swarm", desc: "Free-moving particles that assemble a heart" },
      { href: "smart3d.html", icon: "◍", title: "3D voxels", desc: "A ringed planet grown in a 16³ grid" },
    ],
  },
  {
    group: "3D shapes · orchestrated swarms",
    items: [
      { href: "heart3d.html", icon: "♥", title: "Orchestrated 3D", desc: "Built-in shapes, your images or a local AI model" },
      { href: "heart3d-train.html", icon: "⚙", title: "Train the orchestrator", desc: "Evolve the brain that directs the swarm" },
      { href: "carve3d.html", icon: "◩", title: "Carve from views", desc: "Front, side and top pictures carve a 3D form" },
      { href: "look3d.html", icon: "◐", title: "One picture → 3D", desc: "The swarm inflates a silhouette like a balloon" },
      { href: "depth3d.html", icon: "◭", title: "AI depth → 3D", desc: "A depth model turns a photo into a relief" },
    ],
  },
];

const here = (location.pathname.split("/").pop() || "index.html").toLowerCase();
const current = PAGES.flatMap((g) => g.items).find((p) => p.href === here);

const MARK = `<svg class="brand-mark" viewBox="0 0 26 26" aria-hidden="true">
  <defs><radialGradient id="spg" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#bfe4ff"/><stop offset="1" stop-color="#3d8fd6"/></radialGradient></defs>
  <rect width="26" height="26" rx="7" fill="#0b1626"/>
  <circle cx="13" cy="13" r="3.2" fill="url(#spg)"/>
  <circle cx="6.5" cy="8" r="1.5" fill="#70c1ff" opacity=".9"/><circle cx="19.5" cy="7" r="1.2" fill="#70c1ff" opacity=".7"/>
  <circle cx="20" cy="17.5" r="1.7" fill="#70c1ff" opacity=".85"/><circle cx="8" cy="19" r="1.1" fill="#70c1ff" opacity=".6"/>
  <circle cx="13" cy="4.5" r=".8" fill="#70c1ff" opacity=".5"/><circle cx="4" cy="14" r=".8" fill="#70c1ff" opacity=".5"/>
</svg>`;
const ICON_MENU = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2.5 4h11M2.5 8h11M2.5 12h11"/></svg>`;
const ICON_COLLAPSE = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 10l4-4 4 4"/></svg>`;

function brand() {
  const el = document.createElement("div");
  el.className = "brand";
  el.innerHTML = `${MARK}<div class="brand-text"><small>SuperParticles</small><b>${current ? current.title : document.title}</b></div>`;
  return el;
}

function iconButton(cls, label, svg) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `icon-btn ${cls}`;
  b.title = label;
  b.setAttribute("aria-label", label);
  b.innerHTML = svg;
  return b;
}

// ── page menu ──────────────────────────────────────────────
let menu = null;
function closeMenu() {
  menu?.remove();
  menu = null;
  document.querySelectorAll(".menu-btn").forEach((b) => b.setAttribute("aria-expanded", "false"));
}
function openMenu(btn) {
  if (menu) return closeMenu();
  menu = document.createElement("nav");
  menu.className = "menu";
  menu.setAttribute("aria-label", "Playground pages");
  menu.innerHTML = PAGES.map((g) => `<h4>${g.group}</h4>` + g.items.map((p) =>
    `<a href="./${p.href}"${p.href === here ? ' aria-current="page"' : ""}><span class="ico">${p.icon}</span><b>${p.title}</b><span>${p.desc}</span></a>`).join("")).join("");
  document.body.append(menu);
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth;
  menu.style.top = `${Math.round(r.bottom + 6)}px`;
  menu.style.left = `${Math.round(Math.max(12, Math.min(r.right - w, innerWidth - w - 12)))}px`;
  if (r.left < innerWidth / 2) menu.style.left = `${Math.round(Math.max(12, Math.min(r.left - 8, innerWidth - w - 12)))}px`;
  btn.setAttribute("aria-expanded", "true");
  menu.querySelector('[aria-current="page"], a')?.focus({ preventScroll: true });
}
addEventListener("keydown", (e) => { if (e.key === "Escape") closeMenu(); });
addEventListener("pointerdown", (e) => {
  if (menu && !menu.contains(e.target) && !e.target.closest(".menu-btn")) closeMenu();
});
let lastW = innerWidth;
addEventListener("resize", () => { if (Math.abs(innerWidth - lastW) > 80) closeMenu(); lastW = innerWidth; });

function menuButton(withText) {
  const b = iconButton("menu-btn", "All pages", ICON_MENU);
  b.setAttribute("aria-haspopup", "true");
  b.setAttribute("aria-expanded", "false");
  if (withText) b.insertAdjacentHTML("beforeend", "<span>Pages</span>");
  b.onclick = () => openMenu(b);
  return b;
}

// ── build the shell ───────────────────────────────────────
const panel = document.getElementById("panel");
if (panel) {
  document.body.classList.add("app");
  const body = document.createElement("div");
  body.className = "panel-body";
  body.append(...panel.childNodes);
  const head = brand();
  const collapse = iconButton("collapse-btn", "Hide controls", ICON_COLLAPSE);
  collapse.onclick = () => {
    const c = panel.classList.toggle("collapsed");
    collapse.title = c ? "Show controls" : "Hide controls";
    collapse.setAttribute("aria-label", collapse.title);
    collapse.setAttribute("aria-expanded", String(!c));
  };
  collapse.setAttribute("aria-expanded", "true");
  head.append(menuButton(false), collapse);
  panel.prepend(head);
  panel.append(body);
  // on phones the panel would cover the whole stage: start with just the header showing
  if (matchMedia("(max-width: 699px)").matches) collapse.click();
  // a second floating panel on the right (carve3d cameras)
  document.querySelectorAll("aside.side.right").forEach(() => document.body.classList.add("has-right"));
} else {
  document.body.classList.add("doc");
  const bar = document.createElement("header");
  bar.className = "topbar";
  const b = brand();
  bar.append(b, menuButton(true));
  document.body.prepend(bar);
}

// ── filled slider tracks ─────────────────────────────────
function fill(el) {
  const min = Number(el.min || 0), max = Number(el.max || 100);
  const pct = max > min ? ((Number(el.value) - min) / (max - min)) * 100 : 0;
  el.style.setProperty("--fill", `${pct}%`);
}
const fillAll = () => document.querySelectorAll('input[type="range"]').forEach(fill);
document.addEventListener("input", (e) => { if (e.target.matches?.('input[type="range"]')) fill(e.target); }, true);
fillAll();
// scripts also set slider values directly (presets, reset); keep the tracks in step
setInterval(fillAll, 400);
