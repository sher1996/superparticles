// Orchestrated 3D heart page: the hand-written orchestrator (planner) directing 600 smart
// particles, with followers drawn in the playground's particle look.

import { createWorld, Swarm } from "./heart3d-sim.js";
import { SHAPES, imageToMask, cutOutPng, parseDistanceGrid } from "./heart3d-shapes.js";
import { parseBrainFile } from "./heart3d-es.js";
import { createView, hexToRgb } from "./heart3d-view.js";
import { pictureColors, createPainter, surfaceBox } from "./heart3d-colors.js";

const $ = (id) => document.getElementById(id);
const SAVE_KEY = "sp_orchestrator_brain";
let world = createWorld({ smart: 600 });
let swarm = new Swarm(world, { mode: "planner", followers: 8000 });
const view = createView($("view"));
let showSmart = false;
let brain = null; // trained weights, when "Trained brain" is chosen

// ---- shape -------------------------------------------------------------------------------------

for (const [kind, label] of Object.entries(SHAPES)) $("shape").append(new Option(label, kind));
let smartCount = 600;
function useShape(spec) {
  world = createWorld({ smart: smartCount, shape: spec });
  swarm = new Swarm(world, { mode: swarm.mode, brain: swarm.brain, followers: swarm.followers });
  swarm.blob();
  repaint();
}

// ---- colours: every follower takes its colour from where it is -------------------------------

const pictures = {};   // shape option → the picture's colours, for shapes made from a picture
let painter = null, colors = new Float32Array(0);
function repaint() {
  const picture = pictures[$("shape").value] ?? null;
  const opt = $("paint").querySelector('option[value="picture"]');
  opt.disabled = !picture;
  opt.textContent = picture ? "From the picture" : "From the picture (use a picture first)";
  if (!picture && $("paint").value === "picture") $("paint").value = "single";
  $("color2-row").hidden = $("paint").value !== "gradient";
  $("color").parentElement.querySelector("span").textContent = $("paint").value === "gradient" ? "Top" : "Colour";
  painter = createPainter({ mode: $("paint").value, color: view.color, color2: hexToRgb($("color2").value), picture, box: surfaceBox(world.target) });
}
function paintFollowers() {
  if (colors.length !== swarm.followers * 3) colors = new Float32Array(swarm.followers * 3);
  painter(swarm.fPos, swarm.followers, colors);
}
/** Remember a picture's colours for a shape made from it, and colour the particles with them. */
function usePicture(key, image) {
  pictures[key] = pictureColors(image);
  if (pictures[key]) $("paint").value = "picture";
}
$("paint").onchange = repaint;
$("color2").oninput = repaint;
$("shape").onchange = (e) => useShape({ kind: e.target.value });
$("upload").onclick = () => $("image").click();
$("image").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const bitmap = await createImageBitmap(file);
  const { mask, w, h } = imageToMask(bitmap);
  if (mask.reduce((a, b) => a + b, 0) < 30) {
    alert("Couldn't find a clear shape in that image. Try a bold silhouette on a plain or transparent background.");
    return;
  }
  if (![...$("shape").options].some((o) => o.value === "image")) $("shape").append(new Option("Your image", "image"));
  $("shape").value = "image";
  usePicture("image", bitmap);
  useShape({ kind: "image", mask, w, h, name: file.name.replace(/\.[^.]+$/, "") });
};

// ---- image → full 3D object with the local AI helper (tools/image3d/server.py) ---------------

const HELPER = "http://127.0.0.1:8765";
$("ai-upload").onclick = () => $("ai-image").click();
$("ai-image").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  e.target.value = "";
  const note = $("ai-note"), btn = $("ai-upload");
  try {
    const status = await fetch(`${HELPER}/status`).then((r) => r.json());
    if (!status.weights) throw new Error("the helper is running, but the TripoSG weights are not downloaded yet (see tools/image3d/README.md)");
    btn.disabled = true;
    note.textContent = `Imagining the 3D object on your ${status.device}${status.loaded ? "" : " (first time: loading the model, about a minute)"}…`;
    const t0 = performance.now();
    const bitmap = await createImageBitmap(file);
    const png = await cutOutPng(bitmap);
    const reply = await fetch(`${HELPER}/generate`, { method: "POST", headers: { "Content-Type": "image/png" }, body: png });
    if (!reply.ok) throw new Error((await reply.json()).error);
    const name = file.name.replace(/\.[^.]+$/, "");
    const spec = parseDistanceGrid(await reply.arrayBuffer(), name);
    if (![...$("shape").options].some((o) => o.value === "ai")) $("shape").append(new Option("AI 3D object", "ai"));
    $("shape").value = "ai";
    usePicture("ai", bitmap);
    useShape(spec);
    note.textContent = `“${name}” in 3D: the AI took ${spec.seconds} s, ${((performance.now() - t0) / 1000).toFixed(0)} s in all. Turn it to see the back.`;
  } catch (err) {
    note.textContent = err instanceof TypeError
      ? "The local AI helper isn't running. Start it with tools/image3d/.venv/Scripts/python.exe tools/image3d/server.py, then try again."
      : `Couldn't make it 3D: ${err.message}`;
  } finally {
    btn.disabled = false;
  }
};

// ---- orchestrator: hand-written, or a trained brain ------------------------------------------

function useBrain(doc, label) {
  brain = parseBrainFile(doc);
  const opt = $("brain").querySelector('option[value="saved"]');
  opt.disabled = false;
  opt.textContent = `Trained brain (${label})`;
  $("brain").value = "saved";
  swarm.mode = "learned";
  swarm.brain = brain;
  swarm.zone.fill(-1);
  $("brain-note").textContent = `Trained on the ${doc.trainedOn ?? "?"}, generation ${doc.generation ?? "?"}, score ${doc.score ?? "?"} (hand-written ${doc.handWritten ?? "?"}).`;
}
try {
  const saved = JSON.parse(localStorage.getItem(SAVE_KEY) || "null");
  if (saved) {
    const opt = $("brain").querySelector('option[value="saved"]');
    opt.disabled = false;
    opt.textContent = `Trained brain (saved, ${saved.trainedOn})`;
  }
} catch {}
$("brain").onchange = (e) => {
  if (e.target.value === "planner") {
    swarm.mode = "planner";
    $("brain-note").innerHTML = '<a href="./heart3d-train.html">Train a brain</a> and it is saved in this browser.';
    return;
  }
  try { useBrain(JSON.parse(localStorage.getItem(SAVE_KEY)), "saved"); } catch (err) { alert(err.message); $("brain").value = "planner"; }
};
$("load").onclick = () => $("brain-file").click();
$("brain-file").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try { useBrain(JSON.parse(await file.text()), file.name.replace(/\.json$/, "")); } catch (err) { alert(err.message); }
};

let running = true, simSpeed = 1, last = performance.now(), t = 0, tick = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * simSpeed;
  last = now;
  if (running) {
    t += dt;
    for (let s = 0; s < 2; s++) swarm.stepSmart(dt / 2);
    swarm.stepFollowers(dt, t);
    if (tick % 12 === 0) swarm.orchestrate();
    if (tick % 30 === 0) { swarm.measure(); showStats(); }
    tick++;
  }
  if (tick % 4 === 0 || colors.length !== swarm.followers * 3) paintFollowers();
  const layers = [{ points: swarm.fPos, count: swarm.followers, colors }];
  if (showSmart) layers.push({ points: swarm.pos, count: world.smart, size: view.size * 2.2, color: [1, 1, 1] });
  view.draw(layers);
  requestAnimationFrame(frame);
}

function showStats() {
  const s = swarm.stats;
  $("report").replaceChildren(...swarm.report.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
  $("stat-cover").textContent = `${(s.coverage * 100).toFixed(1)}%`;
  $("stat-thin").textContent = s.thinCoverage == null ? "none on this shape" : `${(s.thinCoverage * 100).toFixed(1)}%`;
  $("stat-err").textContent = `${(s.surfErr * 100).toFixed(2)}`;
  $("stat-team").textContent = `${s.missing} missing · ${s.crowded} crowded · ${s.strays} strays`;
}

$("smart").oninput = (e) => { $("smart-value").textContent = e.target.value; };
$("smart").onchange = (e) => { smartCount = Number(e.target.value); useShape(world.spec); };
$("followers").oninput =(e) => { $("followers-value").textContent = e.target.value; swarm.setFollowers(Number(e.target.value)); };
$("size").oninput = (e) => { $("size-value").textContent = e.target.value; view.size = Number(e.target.value); };
$("speed").oninput = (e) => { $("speed-value").textContent = e.target.value; simSpeed = Number(e.target.value) / 40; };
$("color").oninput = (e) => { view.color = hexToRgb(e.target.value); repaint(); };
$("depth").onchange = (e) => { view.depth = e.target.checked; };
$("show-smart").onchange = (e) => { showSmart = e.target.checked; };
$("rotate").onchange = (e) => { view.autoRotate = e.target.checked; };
$("play").onclick = () => { running = !running; $("play").textContent = running ? "Pause" : "Play"; };
$("reset").onclick = () => swarm.blob();
$("scatter").onclick = () => {
  const i = Math.floor(Math.random() * world.smart);
  swarm.scatter(swarm.pos[3 * i], swarm.pos[3 * i + 1], swarm.pos[3 * i + 2], 0.6, 2.5);
};
$("explode").onclick = () => swarm.scatter(0, 0, 0, 5, 3);
$("cut-lobe").onclick = () => swarm.scatter(-0.55, 0.75, 0, 0.55, 4);

swarm.blob();
repaint();
window.heart3d = { get swarm() { return swarm; }, get world() { return world; }, useShape, get stats() { return swarm.stats; }, get report() { return swarm.report; }, measure: () => swarm.measure() };
requestAnimationFrame(frame);
