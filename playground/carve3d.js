// Carving page: the user's 2–3 views become cameras; the orchestrator carves the swarm until every
// camera sees its own outline. Drawn with the same 3D dot view as the other 3D pages.

import { CarveSwarm, buildCameras, VIEWS } from "./carve3d-sim.js";
import { SETS, drawView } from "./carve3d-sets.js";
import { imageToMask } from "./heart3d-shapes.js";
import { createView, hexToRgb } from "./heart3d-view.js";

const $ = (id) => document.getElementById(id);
const KINDS = ["front", "side", "top"];
const view = createView($("view"));
let views = {};   // kind → { mask, w, h, source }
let swarm = null, showSmart = false;

// ---- views: built-in sets and uploads ---------------------------------------------------------

for (const [key, set] of Object.entries(SETS)) $("set").append(new Option(set.label, key));
$("set").append(Object.assign(new Option("Your own views", "own"), { disabled: true }));

function loadSet(key) {
  $("set").value = key;
  views = {};
  for (const [kind, paint] of Object.entries(SETS[key].views)) views[kind] = { ...imageToMask(drawView(paint), 96), source: "built-in" };
  apply(true);
}

/** Build the cameras from the current views and hand them to the swarm. */
function apply(fresh) {
  let cams;
  try { cams = buildCameras(views); } catch (err) { alert(err.message); return false; }
  if (!swarm) { swarm = new CarveSwarm(cams, { followers: Number($("followers").value) }); swarm.blob(); }
  else { swarm.setCameras(cams); if (fresh) swarm.blob(); }
  for (const k of KINDS) $(`src-${k}`).textContent = views[k] ? views[k].source : "not given";
  buildCamPanel();
  return true;
}

let uploadSlot = "front";
document.querySelectorAll("[data-up]").forEach((b) => (b.onclick = () => { uploadSlot = b.dataset.up; $("file").value = ""; $("file").click(); }));
document.querySelectorAll("[data-clear]").forEach((b) => (b.onclick = () => {
  const old = views[b.dataset.clear];
  delete views[b.dataset.clear];
  if (!apply(false)) { views[b.dataset.clear] = old; apply(false); }
}));
$("file").onchange = (e) => { if (e.target.files[0]) useFile(uploadSlot, e.target.files[0]); };

/** An uploaded picture becomes that view's outline; the swarm stays where it is and gets re-carved. */
async function useFile(kind, file) {
  const m = imageToMask(await createImageBitmap(file), 96);
  if (m.mask.reduce((a, b) => a + b, 0) < 30) {
    alert("Couldn't find a clear shape in that image. Try a bold silhouette on a plain or transparent background.");
    return false;
  }
  const old = views[kind];
  views[kind] = { ...m, source: file.name };
  if (!apply(false)) { if (old) views[kind] = old; else delete views[kind]; return false; }
  $("set").querySelector('option[value="own"]').disabled = false;
  $("set").value = "own";
  return true;
}
$("set").onchange = (e) => { if (e.target.value !== "own") loadSet(e.target.value); };

// ---- camera panel ----------------------------------------------------------------------------

let camUI = [];
function buildCamPanel() {
  const list = $("cam-list");
  list.replaceChildren();
  camUI = [];
  for (const kind of KINDS) {
    const box = document.createElement("div");
    box.className = "cam";
    const c = swarm.cams.findIndex((cam) => cam.kind === kind);
    box.innerHTML = `<div class="cam-head"><span>${VIEWS[kind].label} <small style="font-weight:400;color:#9ca3af">${VIEWS[kind].dir}</small></span><b>–</b></div>`;
    if (c < 0) {
      box.insertAdjacentHTML("beforeend", `<div class="cam-off">not given${kind === "top" ? " (optional)" : ""}</div>`);
      list.append(box);
      continue;
    }
    const cam = swarm.cams[c];
    const pics = document.createElement("div");
    pics.className = "cam-pics";
    const given = Object.assign(document.createElement("canvas"), { width: cam.W, height: cam.H });
    const sees = Object.assign(document.createElement("canvas"), { width: cam.W, height: cam.H });
    const wrap = (cv, label) => { const d = document.createElement("div"); d.append(cv, Object.assign(document.createElement("small"), { textContent: label })); return d; };
    pics.append(wrap(given, "given"), wrap(sees, "camera sees"));
    box.append(pics);
    box.append(Object.assign(document.createElement("div"), { className: "cam-off", textContent: "" }));
    list.append(box);
    const g = given.getContext("2d"), img = g.createImageData(cam.W, cam.H);
    for (let p = 0; p < cam.mask.length; p++) {
      const v = cam.mask[p] ? 230 : 0;
      img.data.set([v, v, v, 255], p * 4);
    }
    g.putImageData(img, 0, 0);
    camUI.push({ c, cam, sees, score: box.querySelector("b"), note: box.lastChild });
  }
}

function drawCams() {
  const col = view.color.map((v) => Math.round(v * 255));
  for (const ui of camUI) {
    const { cam, c } = ui, grid = swarm.fCover[c], st = swarm.views[c];
    const g = ui.sees.getContext("2d"), img = g.createImageData(cam.W, cam.H);
    for (let p = 0; p < grid.length; p++) {
      const m = cam.mask[p], s = grid[p];
      const rgb = m && s ? col : s ? [239, 68, 68] : m ? [75, 85, 99] : [0, 0, 0];
      img.data.set([rgb[0], rgb[1], rgb[2], 255], p * 4);
    }
    g.putImageData(img, 0, 0);
    ui.score.textContent = `${(st.match * 100).toFixed(1)}% match`;
    ui.note.textContent = `${(st.outside * 100).toFixed(1)}% of dots outside the outline` + (st.disagree > 0.01 ? ` · ${(st.disagree * 100).toFixed(0)}% of outline ruled out by other views` : "");
  }
  $("report").replaceChildren(...swarm.report.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
}

// ---- loop ------------------------------------------------------------------------------------

let running = true, simSpeed = 1, last = performance.now(), t = 0, tick = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * simSpeed;
  last = now;
  if (running && swarm) {
    t += dt;
    for (let s = 0; s < 2; s++) swarm.stepSmart(dt / 2);
    swarm.stepFollowers(dt, t);
    if (tick % 3 === 0) swarm.orchestrate();
    if (tick % 12 === 0) swarm.fillGaps();
    if (tick % 20 === 0) { swarm.measure(); drawCams(); }
    tick++;
  }
  if (swarm) {
    const layers = [{ points: swarm.fPos, count: swarm.followers }];
    if (showSmart) layers.push({ points: swarm.pos, count: swarm.n, size: view.size * 2.2, color: [1, 1, 1] });
    view.draw(layers);
  }
  requestAnimationFrame(frame);
}

// ---- controls --------------------------------------------------------------------------------

$("followers").oninput = (e) => { $("followers-value").textContent = e.target.value; swarm.setFollowers(Number(e.target.value)); };
$("size").oninput = (e) => { $("size-value").textContent = e.target.value; view.size = Number(e.target.value); };
$("speed").oninput = (e) => { $("speed-value").textContent = e.target.value; simSpeed = Number(e.target.value) / 40; };
$("color").oninput = (e) => { view.color = hexToRgb(e.target.value); };
$("depth").onchange = (e) => { view.depth = e.target.checked; };
$("show-smart").onchange = (e) => { showSmart = e.target.checked; };
$("rotate").onchange = (e) => { view.autoRotate = e.target.checked; };
$("play").onclick = () => { running = !running; $("play").textContent = running ? "Pause" : "Play"; };
$("reset").onclick = () => swarm.blob();
const randomSmart = () => { const i = Math.floor(Math.random() * swarm.n); return [swarm.pos[3 * i], swarm.pos[3 * i + 1], swarm.pos[3 * i + 2]]; };
$("knock").onclick = () => { const [x, y, z] = randomSmart(); swarm.throwOut(x, y, z, 0.45); };
$("scatter").onclick = () => { const [x, y, z] = randomSmart(); swarm.scatter(x, y, z, 0.6, 2.5); };
$("explode").onclick = () => swarm.explode();

const TURN = { front: [0, 0], side: [-Math.PI / 2, 0], top: [0, Math.PI / 2], free: [0.6, -0.15] };
document.querySelectorAll("[data-turn]").forEach((b) => (b.onclick = () => {
  const k = b.dataset.turn;
  view.autoRotate = k === "free";
  $("rotate").checked = view.autoRotate;
  if (TURN[k]) [view.yaw, view.pitch] = TURN[k];
  document.querySelectorAll("[data-turn]").forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
}));

loadSet("heart");
window.carve3d = {
  get swarm() { return swarm; }, get views() { return views; }, loadSet, apply, upload: useFile,
  /** Step the simulation without drawing (for measuring), 60 frames = 1 s. */
  run(frames) {
    for (let k = 0; k < frames; k++, tick++) {
      t += 1 / 60;
      swarm.stepSmart(1 / 120); swarm.stepSmart(1 / 120);
      swarm.stepFollowers(1 / 60, t);
      if (tick % 3 === 0) swarm.orchestrate();
      if (tick % 12 === 0) swarm.fillGaps();
    }
    swarm.measure(); drawCams();
    return this.scores();
  },
  scores: () => swarm.views.map((v) => ({ view: v.label, match: +(v.match * 100).toFixed(1), outside: +(v.outside * 100).toFixed(1), disagree: +(v.disagree * 100).toFixed(1) })),
};
requestAnimationFrame(frame);
