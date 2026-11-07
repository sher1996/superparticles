// "Look and correct" page: the swarm works out a 3D form from one picture by itself.

import { imageToMask } from "./heart3d-shapes.js";
import { createView, hexToRgb } from "./heart3d-view.js";
import { createLook, LookSwarm } from "./look3d-sim.js";

const $ = (id) => document.getElementById(id);
const SMART = 700;

// ---- built-in test drawings (plain black on white, like a scanned drawing) -----------------------

function drawing(kind) {
  const c = document.createElement("canvas");
  c.width = 320; c.height = 320;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = "#111";
  g.beginPath();
  if (kind === "heart") {
    for (let k = 0; k <= 200; k++) {
      const t = (k / 200) * Math.PI * 2;
      const x = 16 * Math.sin(t) ** 3, y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
      g.lineTo(160 + x * 8.6, 150 - y * 8.6);
    }
    g.fill();
  } else if (kind === "hi") {
    c.width = 420; c.height = 260;
    g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#111";
    g.font = '900 230px "Arial Black", Arial, sans-serif';
    g.textAlign = "center"; g.textBaseline = "middle";
    g.fillText("HI", 210, 140);
  } else if (kind === "circle") {
    g.arc(160, 160, 130, 0, Math.PI * 2); g.fill();
  } else if (kind === "ring") {
    g.arc(160, 160, 140, 0, Math.PI * 2); g.arc(160, 160, 62, 0, Math.PI * 2, true); g.fill();
  } else if (kind === "star") {
    for (let i = 0; i < 10; i++) {
      const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 62 : 150;
      g.lineTo(160 + Math.cos(a) * r, 170 + Math.sin(a) * r);
    }
    g.fill();
  }
  return c;
}
const DRAWINGS = { heart: "Heart (drawing)", hi: '"HI" text', circle: "Circle", ring: "Ring (with a hole)", star: "Star" };
for (const [k, label] of Object.entries(DRAWINGS)) $("picture").append(new Option(label, k));

// ---- state -----------------------------------------------------------------------------------------

let look, swarm, picName = "heart";
const view = createView($("view"));
let showSmart = false, followers = 8000;

function usePicture(source, name) {
  const { mask, w, h } = imageToMask(source);
  if (mask.reduce((a, b) => a + b, 0) < 30) {
    alert("Couldn't find a clear shape in that image. Try a bold silhouette on a plain or transparent background.");
    return false;
  }
  picName = name;
  look = createLook({ mask, w, h, smart: SMART });
  swarm = new LookSwarm(look, { followers, inflate: Number($("inflate").value) / 100 });
  swarm.blob();
  drawMask();
  return true;
}

$("picture").onchange = (e) => usePicture(drawing(e.target.value), e.target.value);
$("upload").onclick = () => $("image").click();
$("image").onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!usePicture(await createImageBitmap(file), file.name.replace(/\.[^.]+$/, ""))) return;
  if (![...$("picture").options].some((o) => o.value === "upload")) $("picture").append(new Option("Your image", "upload"));
  $("picture").value = "upload";
};

// ---- the little views: picture, what the camera sees, side view ---------------------------------------

function fit(canvas) {
  canvas.width = look.w; canvas.height = look.h;
  return canvas.getContext("2d");
}
function drawMask() {
  const g = fit($("mask-view")), img = g.createImageData(look.w, look.h);
  for (let p = 0; p < look.mask.length; p++) {
    const v = look.mask[p] ? 230 : 25;
    img.data.set([v, v, v, 255], p * 4);
  }
  g.putImageData(img, 0, 0);
}
function drawCamera() {
  const g = fit($("cam-view")), img = g.createImageData(look.w, look.h), cam = swarm.cam;
  for (let p = 0; p < look.mask.length; p++) {
    const a = cam[p] > 0, b = look.mask[p] > 0;
    // match = pale blue, particles but no shape = red, shape but no particles = yellow
    img.data.set(a && b ? [112, 193, 255, 255] : a ? [255, 70, 70, 255] : b ? [255, 210, 60, 255] : [10, 10, 10, 255], p * 4);
  }
  g.putImageData(img, 0, 0);
}
function drawSide() {
  const c = $("side-view"), g = c.getContext("2d");
  c.width = 120; c.height = 120;
  g.fillStyle = "#0a0a0a"; g.fillRect(0, 0, 120, 120);
  const s = 120 / 2.6, pos = swarm.pos;
  g.fillStyle = "#70c1ff";
  for (let i = 0; i < look.smart; i++) g.fillRect(60 + pos[3 * i + 2] * s, 60 - pos[3 * i + 1] * s, 1.5, 1.5);
}

// ---- loop -----------------------------------------------------------------------------------------

let running = true, simSpeed = 1, last = performance.now(), t = 0, tick = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * simSpeed;
  last = now;
  if (running) {
    t += dt;
    for (let s = 0; s < 2; s++) swarm.stepSmart(dt / 2);
    swarm.stepFollowers(dt, t);
    if (tick % 4 === 0) swarm.orchestrate();
    if (tick % 12 === 0) { drawCamera(); drawSide(); }
    if (tick % 30 === 0) showStats();
    tick++;
  }
  const layers = [{ points: swarm.fPos, count: swarm.followers }];
  if (showSmart) layers.push({ points: swarm.pos, count: look.smart, size: view.size * 2.2, color: [1, 1, 1] });
  view.draw(layers);
  requestAnimationFrame(frame);
}

function showStats() {
  const s = swarm.shapeStats();
  $("report").replaceChildren(...swarm.report.map((line) => Object.assign(document.createElement("li"), { textContent: line })));
  $("stat-iou").textContent = `${(s.iou * 100).toFixed(1)}%`;
  $("stat-px").textContent = `${s.missingPx} missing · ${s.excessPx} excess`;
  $("stat-depth").textContent = `${(s.thickness / Math.max(1e-6, s.width) * 100).toFixed(0)}% of its width`;
  $("stat-round").textContent = `middle ${s.midDepth.toFixed(2)} · edge ${s.edgeDepth.toFixed(2)}`;
  $("stat-team").textContent = `${s.front} front · ${s.back} back · ${s.outside} outside`;
}

$("inflate").oninput = (e) => { $("inflate-value").textContent = (e.target.value / 100).toFixed(2); swarm.inflate = Number(e.target.value) / 100; };
$("followers").oninput = (e) => { $("followers-value").textContent = e.target.value; followers = Number(e.target.value); swarm.setFollowers(followers); };
$("size").oninput = (e) => { $("size-value").textContent = e.target.value; view.size = Number(e.target.value); };
$("speed").oninput = (e) => { $("speed-value").textContent = e.target.value; simSpeed = Number(e.target.value) / 40; };
$("color").oninput = (e) => { view.color = hexToRgb(e.target.value); };
$("depth").onchange = (e) => { view.depth = e.target.checked; };
$("show-smart").onchange = (e) => { showSmart = e.target.checked; };
$("rotate").onchange = (e) => { view.autoRotate = e.target.checked; };
const turnTo = (yaw) => { view.autoRotate = false; $("rotate").checked = false; view.yaw = yaw; view.pitch = 0; };
$("front").onclick = () => turnTo(0);
$("side").onclick = () => turnTo(Math.PI / 2);
$("play").onclick = () => { running = !running; $("play").textContent = running ? "Pause" : "Play"; };
$("reset").onclick = () => swarm.blob();
$("scatter").onclick = () => {
  const i = Math.floor(Math.random() * look.smart);
  swarm.scatter(swarm.pos[3 * i], swarm.pos[3 * i + 1], swarm.pos[3 * i + 2], 0.45, 0.9);
};
$("explode").onclick = () => swarm.scatter(0, 0, 0, 5, 1.6);
$("squash").onclick = () => swarm.squash();

usePicture(drawing("heart"), "heart");
window.look3d = {
  get swarm() { return swarm; }, get look() { return look; }, get stats() { return swarm.shapeStats(); }, get report() { return swarm.report; },
  view, drawing, usePicture, turnTo,
};
requestAnimationFrame(frame);
