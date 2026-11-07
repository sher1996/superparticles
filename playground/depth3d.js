// AI depth → 3D swarm. A pretrained depth model (Depth Anything V2 Small, in the browser) guesses
// how near every pixel of one picture is; the silhouette plus that depth becomes a 3D relief, and
// the orchestrated swarm (orchestrator → 600 smart particles → followers) builds it.

import { Swarm } from "./heart3d-sim.js";
import { imageToMask } from "./heart3d-shapes.js";
import { createView, hexToRgb } from "./heart3d-view.js";
import { buildDepthShape, cleanMask, otsu } from "./depth3d-surface.js";
import { createShapeWorld } from "./depth3d-world.js";
import { MODEL_ID, LIB_VERSION, MODEL_FILES, pickBackend, loadDepthModel, estimateDepth } from "./depth3d-model.js";

const $ = (id) => document.getElementById(id);
const GRID = 112;      // the picture is looked at on a grid this big (longest side) to make the 3D target
const MAX_PIC = 512;   // pictures are shrunk to this before the model sees them
const COLOURS = 12;    // followers are drawn in this many colours taken from the picture

const view = createView($("view"));
view.size = 2;
let world = null, swarm = null, followers = 12000, showSmart = false, useColours = true;

// ---- the picture ---------------------------------------------------------------------------------

const pic = {
  src: null,      // canvas, longest side ≤ MAX_PIC (keeps transparency)
  name: "",
  w: 0, h: 0,     // grid size
  colourMask: null, colourOk: false, transparent: false,
  rgb: null,      // grid colours
  depth: null,    // grid depth 0..1 over the whole picture (1 = nearest), null until the model ran
  full: null,     // the model's depth at picture size, 0..1, for the thumbnail
  mask: null, depthN: null, outlineUsed: "",
};
let generation = 0;

function toCanvas(image) {
  const s = Math.min(1, MAX_PIC / Math.max(image.width, image.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(image.width * s));
  c.height = Math.max(1, Math.round(image.height * s));
  c.getContext("2d").drawImage(image, 0, 0, c.width, c.height);
  return c;
}

/** The model gets the picture on white (transparent pixels would read as black). */
function onWhite(src) {
  const c = document.createElement("canvas");
  c.width = src.width; c.height = src.height;
  const g = c.getContext("2d");
  g.fillStyle = "#fff"; g.fillRect(0, 0, c.width, c.height);
  g.drawImage(src, 0, 0);
  return c;
}

/** A shaded cartoon bear head: a drawing with clear depth cues (snout in front, ears behind). */
function testPicture() {
  const c = document.createElement("canvas");
  c.width = c.height = 512;
  const g = c.getContext("2d");
  g.fillStyle = "#f3efe7";
  g.fillRect(0, 0, 512, 512);
  const ball = (x, y, r, [R, G, B], light = 1.35) => {
    const gr = g.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.05, x, y, r);
    const f = (k) => `rgb(${Math.min(255, R * k) | 0},${Math.min(255, G * k) | 0},${Math.min(255, B * k) | 0})`;
    gr.addColorStop(0, f(light)); gr.addColorStop(0.55, f(1)); gr.addColorStop(1, f(0.45));
    g.fillStyle = gr;
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  };
  ball(140, 150, 72, [140, 88, 50]); ball(372, 150, 72, [140, 88, 50]);       // ears
  ball(146, 156, 38, [200, 150, 110], 1.15); ball(366, 156, 38, [200, 150, 110], 1.15);
  ball(256, 290, 175, [150, 95, 55]);                                          // head
  ball(256, 360, 84, [218, 178, 132], 1.2);                                    // snout
  ball(256, 328, 28, [45, 28, 22], 2.2);                                       // nose
  ball(190, 248, 17, [30, 20, 18], 2.5); ball(322, 248, 17, [30, 20, 18], 2.5); // eyes
  g.strokeStyle = "rgba(60,35,25,0.8)"; g.lineWidth = 5; g.lineCap = "round";
  g.beginPath(); g.moveTo(256, 356); g.lineTo(256, 385);
  g.quadraticCurveTo(240, 405, 222, 395); g.moveTo(256, 385); g.quadraticCurveTo(272, 405, 290, 395); g.stroke();
  return c;
}

async function usePicture(image, name) {
  const gen = ++generation;
  pic.src = toCanvas(image);
  pic.name = name;
  pic.depth = pic.full = null;
  const cm = imageToMask(pic.src, GRID);
  pic.w = cm.w; pic.h = cm.h;
  // colours on the grid, and whether "background colour" makes a sensible outline
  const g = Object.assign(document.createElement("canvas"), { width: cm.w, height: cm.h }).getContext("2d", { willReadFrequently: true });
  g.drawImage(pic.src, 0, 0, cm.w, cm.h);
  const px = g.getImageData(0, 0, cm.w, cm.h).data;
  pic.rgb = new Uint8Array(cm.w * cm.h * 3);
  pic.transparent = false;
  for (let i = 0; i < cm.w * cm.h; i++) {
    pic.rgb[3 * i] = px[4 * i]; pic.rgb[3 * i + 1] = px[4 * i + 1]; pic.rgb[3 * i + 2] = px[4 * i + 2];
    if (px[4 * i + 3] < 128) pic.transparent = true;
  }
  const corner = (i, j) => (j * cm.w + i) * 4, cs = [corner(0, 0), corner(cm.w - 1, 0), corner(0, cm.h - 1), corner(cm.w - 1, cm.h - 1)];
  const cornersAgree = cs.every((o) => Math.abs(px[o] - px[cs[0]]) + Math.abs(px[o + 1] - px[cs[0] + 1]) + Math.abs(px[o + 2] - px[cs[0] + 2]) < 60);
  pic.colourMask = cleanMask(cm.mask, cm.w, cm.h);
  const cover = pic.colourMask.reduce((a, b) => a + b, 0) / (cm.w * cm.h);
  pic.colourOk = (pic.transparent || cornersAgree) && cover > 0.02 && cover < 0.95;
  makeTarget(true);
  drawThumbs();
  if (modelReady) await runDepth(gen);
  else updateDownloadText();
}

// ---- depth -------------------------------------------------------------------------------------

let backend = null, modelReady = false, loading = false;

async function updateDownloadText() {
  backend ??= await pickBackend();
  const f = MODEL_FILES[backend.dtype];
  const where = backend.device === "webgpu" ? "your graphics card (WebGPU)" : "your processor (WebAssembly; this browser has no WebGPU, so it is slower)";
  $("download-text").innerHTML = modelReady
    ? `Model ready. New pictures get their depth straight away.`
    : `Pressing the button downloads:<br>• the AI model <b>Depth Anything V2 Small</b> (<code>${MODEL_ID}</code>, ${f.label}, <b>${f.mb} MB</b>) from <b>huggingface.co</b><br>• the <b>transformers.js ${LIB_VERSION}</b> library and the ONNX runtime it uses (about 28 MB more) from <b>cdn.jsdelivr.net</b>.<br>It runs on ${where}. Your picture never leaves this computer. The browser keeps a copy, so next time it starts quickly.`;
}

$("download").onclick = async () => {
  if (loading || modelReady) return;
  loading = true;
  $("download").disabled = true;
  $("progress").hidden = false;
  backend ??= await pickBackend();
  try {
    status("Downloading…");
    const res = await loadDepthModel(backend, ({ loaded, total }) => {
      if (total) { $("progress").value = loaded / total; status(`Downloading… ${(loaded / 1e6).toFixed(1)} of ${(total / 1e6).toFixed(1)} MB`); }
    });
    modelReady = true;
    const mb = res.files.reduce((a, f) => a + (f.bytes || 0), 0) / 1e6;
    stats.load = `model ${mb.toFixed(1)} MB, ready in ${(res.ms / 1000).toFixed(1)} s (${backend.device}, ${backend.dtype})`;
    $("download").hidden = true;
    $("progress").hidden = true;
    updateDownloadText();
    await runDepth(generation);
  } catch (err) {
    console.error(err);
    status(`Couldn't load the model: ${err.message}`);
    $("download").disabled = false;
    if (backend.device === "webgpu") { backend = { device: "wasm", dtype: "q8" }; updateDownloadText(); status(`WebGPU failed (${err.message}). Press again to try the slower WebAssembly version.`); }
  } finally {
    loading = false;
  }
};

const stats = { load: "", infer: "", build: "" };
function status(text) { $("status").textContent = text; }
function showTimes() { status([stats.load, stats.infer, stats.build].filter(Boolean).join(" · ")); }

async function runDepth(gen) {
  status("The AI is looking at the picture…");
  await new Promise((r) => setTimeout(r, 20)); // let the status paint (not rAF: it stalls in a background tab)
  const d = await estimateDepth(onWhite(pic.src));
  if (gen !== generation) return;
  stats.infer = `depth guessed in ${(d.ms / 1000).toFixed(2)} s`;
  // normalise the whole picture to 0..1 (robust to a few extreme pixels)
  const lo = percentile(d.data, 0.01), hi = percentile(d.data, 0.99), span = hi - lo || 1;
  pic.full = { data: d.data.map((v) => Math.min(1, Math.max(0, (v - lo) / span))), w: d.w, h: d.h };
  // onto the grid (bilinear at pixel centres)
  const { w, h } = pic;
  pic.depth = new Float32Array(w * h);
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const fx = Math.min(d.w - 1.001, Math.max(0, ((i + 0.5) / w) * d.w - 0.5)), fy = Math.min(d.h - 1.001, Math.max(0, ((j + 0.5) / h) * d.h - 0.5));
    const x = fx | 0, y = fy | 0, tx = fx - x, ty = fy - y, D = pic.full.data, W = d.w;
    pic.depth[j * w + i] = (D[y * W + x] * (1 - tx) + D[y * W + x + 1] * tx) * (1 - ty) + (D[(y + 1) * W + x] * (1 - tx) + D[(y + 1) * W + x + 1] * tx) * ty;
  }
  makeTarget(false);
  drawThumbs();
}

function percentile(arr, q, sel) {
  const v = [];
  for (let i = 0; i < arr.length; i++) if (!sel || sel[i]) v.push(arr[i]);
  if (!v.length) return 0;
  v.sort((a, b) => a - b);
  return v[Math.min(v.length - 1, Math.floor(q * v.length))];
}

// ---- outline + depth → 3D target → swarm ----------------------------------------------------------

function chooseOutline() {
  const { w, h } = pic, pick = $("outline").value;
  let use = pick;
  if (pick === "auto") use = pic.colourOk ? "colour" : pic.depth ? "depth" : "all";
  if (use === "depth" && !pic.depth) use = pic.colourOk ? "colour" : "all";
  let mask;
  if (use === "colour") mask = pic.colourMask;
  else if (use === "depth") {
    const thr = otsu(pic.depth);
    mask = cleanMask(pic.depth.map((v) => (v > thr ? 1 : 0)), w, h);
    // automatic: if the "nearest part" runs along much of the picture's edge it is floor or table,
    // not an object standing in front of a background, so carve the whole picture instead
    if (pick === "auto") {
      let edge = 0;
      for (let i = 0; i < w; i++) edge += mask[i] + mask[(h - 1) * w + i];
      for (let j = 0; j < h; j++) edge += mask[j * w] + mask[j * w + w - 1];
      if (edge > 0.35 * 2 * (w + h)) { use = "all"; mask = null; }
    }
  }
  mask ??= new Uint8Array(w * h).fill(1);
  pic.outlineUsed = use;
  $("outline-note").textContent = {
    colour: "Outline: everything that differs from the background colour.",
    depth: "Outline: the part the AI thinks is nearest (split from the background by its depth).",
    all: "Outline: the whole picture, as a carved panel (best with the flat back).",
  }[use] + (pick === "auto" ? " (picked automatically)" : "");
  return mask;
}

function makeTarget(fresh) {
  const t0 = performance.now();
  const { w, h } = pic;
  const mask = chooseOutline();
  const depthN = new Float32Array(w * h);
  if (pic.depth) {
    // spread the depth inside the outline over 0..1
    const lo = percentile(pic.depth, 0.02, mask), hi = percentile(pic.depth, 0.98, mask), span = hi - lo || 1;
    for (let i = 0; i < w * h; i++) depthN[i] = mask[i] ? Math.min(1, Math.max(0, (pic.depth[i] - lo) / span)) : 0;
  }
  pic.mask = mask; pic.depthN = depthN;
  const relief = Number($("relief").value);
  const shape = buildDepthShape({
    mask, depth: depthN, w, h, name: pic.name,
    relief: pic.depth ? relief : 0, base: pic.depth ? 0.06 : 0.16, back: $("back").value,
    rim: pic.depth ? 0.12 + 0.35 * relief : 0.12, // thicker reliefs get wider rounded rims
  });
  const old = swarm;
  world = createShapeWorld(shape);
  swarm = new Swarm(world, { mode: "planner", followers });
  if (fresh || !old) swarm.blob();
  else {
    // keep everyone where they are, so the flat cut-out visibly grows into the relief
    swarm.pos.set(old.pos); swarm.vel.set(old.vel);
    if (old.followers === swarm.followers) swarm.fPos.set(old.fPos);
  }
  makePalette();
  stats.build = `3D target (${shape.info.voxels.join("×")} voxels) built in ${((performance.now() - t0) / 1000).toFixed(2)} s`;
  if (pic.depth) showTimes();
  else { status(`No depth yet: the swarm builds a flat cut-out of the picture. ${stats.build}`); }
}

// ---- colours from the picture --------------------------------------------------------------------

let palette = [], colourIdx = null, layers = [];
function makePalette() {
  const { w, h, rgb, mask } = pic, N = w * h;
  const lift = (v) => 0.1 + 0.9 * (v / 255); // keep dark colours visible on the black background
  // k-means on the outlined pixels
  const sel = [];
  for (let i = 0; i < N; i++) if (mask[i]) sel.push(i);
  const K = Math.min(COLOURS, sel.length);
  const c = [];
  for (let k = 0; k < K; k++) { const p = sel[Math.floor(((k + 0.5) / K) * sel.length)]; c.push([rgb[3 * p], rgb[3 * p + 1], rgb[3 * p + 2]]); }
  const idx = new Uint8Array(N);
  for (let it = 0; it < 8; it++) {
    const sum = c.map(() => [0, 0, 0, 0]);
    for (const p of sel) {
      let best = 0, bd = Infinity;
      for (let k = 0; k < K; k++) {
        const d = (rgb[3 * p] - c[k][0]) ** 2 + (rgb[3 * p + 1] - c[k][1]) ** 2 + (rgb[3 * p + 2] - c[k][2]) ** 2;
        if (d < bd) { bd = d; best = k; }
      }
      idx[p] = best;
      const s = sum[best]; s[0] += rgb[3 * p]; s[1] += rgb[3 * p + 1]; s[2] += rgb[3 * p + 2]; s[3]++;
    }
    for (let k = 0; k < K; k++) if (sum[k][3]) c[k] = [sum[k][0] / sum[k][3], sum[k][1] / sum[k][3], sum[k][2] / sum[k][3]];
  }
  // pixels outside the outline take the colour of the nearest outlined pixel (breadth-first)
  const seen = new Uint8Array(N), queue = new Int32Array(N);
  let qh = 0, qt = 0;
  for (const p of sel) { seen[p] = 1; queue[qt++] = p; }
  while (qh < qt) {
    const p = queue[qh++], i = p % w, j = (p - i) / w;
    for (const q of [i > 0 ? p - 1 : -1, i < w - 1 ? p + 1 : -1, j > 0 ? p - w : -1, j < h - 1 ? p + w : -1]) {
      if (q >= 0 && !seen[q]) { seen[q] = 1; idx[q] = idx[p]; queue[qt++] = q; }
    }
  }
  palette = c.map((v) => v.map(lift));
  colourIdx = idx;
  layers = palette.map((color) => ({ points: new Float32Array(followers * 3), count: 0, color }));
}

/** Followers sorted into one layer per picture colour, by where they are (seen from the front). */
function colourLayers() {
  const { w, h } = pic, scale = world.shape.info.scale, f = swarm.fPos;
  if (layers[0]?.points.length < swarm.followers * 3) layers.forEach((l) => (l.points = new Float32Array(swarm.followers * 3)));
  for (const l of layers) l.count = 0;
  for (let i = 0; i < swarm.followers; i++) {
    const x = f[3 * i], y = f[3 * i + 1];
    const gi = Math.min(w - 1, Math.max(0, Math.floor(x / scale + w / 2))), gj = Math.min(h - 1, Math.max(0, Math.floor(-y / scale + h / 2)));
    const l = layers[colourIdx[gj * w + gi]];
    l.points[3 * l.count] = x; l.points[3 * l.count + 1] = y; l.points[3 * l.count + 2] = f[3 * i + 2];
    l.count++;
  }
  return layers.filter((l) => l.count);
}

// ---- thumbnails ----------------------------------------------------------------------------------

function fit(canvas, w, h) {
  const s = Math.min(canvas.width / w, canvas.height / h);
  return { s, ox: (canvas.width - w * s) / 2, oy: (canvas.height - h * s) / 2 };
}

function drawOutline(g, canvas) {
  const { w, h, mask } = pic, { s, ox, oy } = fit(canvas, w, h);
  g.fillStyle = "#ef4444";
  const at = (i, j) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i];
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    if (at(i, j) && (!at(i - 1, j) || !at(i + 1, j) || !at(i, j - 1) || !at(i, j + 1))) g.fillRect(ox + i * s, oy + j * s, Math.max(1.5, s), Math.max(1.5, s));
  }
}

function drawThumbs() {
  const a = $("pic"), ga = a.getContext("2d");
  ga.clearRect(0, 0, a.width, a.height);
  const fa = fit(a, pic.src.width, pic.src.height);
  ga.drawImage(pic.src, fa.ox, fa.oy, pic.src.width * fa.s, pic.src.height * fa.s);
  drawOutline(ga, a);
  const b = $("depthmap"), gb = b.getContext("2d");
  gb.clearRect(0, 0, b.width, b.height);
  if (!pic.full) {
    gb.fillStyle = "#6b7280"; gb.font = "14px system-ui"; gb.textAlign = "center";
    gb.fillText("not guessed yet", b.width / 2, b.height / 2);
    $("depth-caption").textContent = "AI depth (white = near)";
    return;
  }
  const { data, w, h } = pic.full;
  const img = new ImageData(w, h);
  for (let i = 0; i < w * h; i++) { const v = data[i] * 255; img.data[4 * i] = img.data[4 * i + 1] = img.data[4 * i + 2] = v; img.data[4 * i + 3] = 255; }
  const tmp = Object.assign(document.createElement("canvas"), { width: w, height: h });
  tmp.getContext("2d").putImageData(img, 0, 0);
  const fb = fit(b, w, h);
  gb.drawImage(tmp, fb.ox, fb.oy, w * fb.s, h * fb.s);
  drawOutline(gb, b);
  $("depth-caption").textContent = "AI depth (white = near) + outline";
}

// ---- animation ------------------------------------------------------------------------------------

let running = true, simSpeed = 1, last = performance.now(), t = 0, tick = 0;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) * simSpeed;
  last = now;
  if (swarm) {
    if (running) {
      t += dt;
      for (let s = 0; s < 2; s++) swarm.stepSmart(dt / 2);
      swarm.stepFollowers(dt, t);
      if (tick % 12 === 0) swarm.orchestrate();
      if (tick % 30 === 0) { swarm.measure(); showStats(); }
      tick++;
    }
    const ls = useColours ? colourLayers() : [{ points: swarm.fPos, count: swarm.followers }];
    if (showSmart) ls.push({ points: swarm.pos, count: world.smart, size: view.size * 2.2, color: [1, 1, 1] });
    view.draw(ls);
  }
  requestAnimationFrame(frame);
}

function showStats() {
  const s = swarm.stats;
  $("report").replaceChildren(...swarm.report.map((line) => Object.assign(document.createElement("li"), { textContent: line.replace("off the heart", "off the shape") })));
  $("stat-cover").textContent = `${(s.coverage * 100).toFixed(1)}%`;
  $("stat-err").textContent = `${(s.surfErr * 100).toFixed(2)}`;
  $("stat-team").textContent = `${s.missing} missing · ${s.crowded} crowded · ${s.strays} strays`;
}

// ---- controls ------------------------------------------------------------------------------------

$("test-pic").onclick = () => usePicture(testPicture(), "test bear");
$("upload").onclick = () => $("image").click();
$("image").onchange = async (e) => {
  const file = e.target.files[0];
  if (file) usePicture(await createImageBitmap(file), file.name.replace(/\.[^.]+$/, ""));
};
let rebuildTimer = 0;
const rebuild = () => { clearTimeout(rebuildTimer); rebuildTimer = setTimeout(() => { makeTarget(false); drawThumbs(); }, 150); };
$("relief").oninput = (e) => { $("relief-value").textContent = e.target.value; rebuild(); };
$("back").onchange = rebuild;
$("outline").onchange = rebuild;
$("followers").oninput = (e) => {
  $("followers-value").textContent = e.target.value;
  followers = Number(e.target.value);
  swarm.setFollowers(followers);
};
$("size").oninput = (e) => { $("size-value").textContent = e.target.value; view.size = Number(e.target.value); };
$("speed").oninput = (e) => { $("speed-value").textContent = e.target.value; simSpeed = Number(e.target.value) / 40; };
$("color").oninput = (e) => { view.color = hexToRgb(e.target.value); $("use-colours").checked = useColours = false; };
$("use-colours").onchange = (e) => { useColours = e.target.checked; };
$("depth").onchange = (e) => { view.depth = e.target.checked; };
$("show-smart").onchange = (e) => { showSmart = e.target.checked; };
$("rotate").onchange = (e) => { view.autoRotate = e.target.checked; };
const look = (yaw) => { view.yaw = yaw; view.pitch = 0; view.autoRotate = false; $("rotate").checked = false; };
$("look-front").onclick = () => look(0);
$("look-side").onclick = () => look(Math.PI / 2);
$("play").onclick = () => { running = !running; $("play").textContent = running ? "Pause" : "Play"; };
$("reset").onclick = () => swarm.blob();
$("scatter").onclick = () => {
  const i = Math.floor(Math.random() * world.smart);
  swarm.scatter(swarm.pos[3 * i], swarm.pos[3 * i + 1], swarm.pos[3 * i + 2], 0.6, 2.5);
};
$("explode").onclick = () => swarm.scatter(0, 0, 0, 5, 3);
$("cut-lobe").onclick = () => swarm.scatter(-0.5, 0.6, 0.2, 0.55, 4);

usePicture(testPicture(), "test bear");
updateDownloadText();
window.depth3d = { get swarm() { return swarm; }, get world() { return world; }, pic, stats, view, makeTarget, usePicture };
requestAnimationFrame(frame);
