import { loadModel, NCAGrid3DCPU } from "../dist/nca.js";

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search);
const model = await loadModel(params.get("model") || "../models/planet3d.nca.json");
const grid = new NCAGrid3DCPU(model, { seed: Number(params.get("seed") || 0) });
window.smart3d = grid; // for experiments in the console (and tests)

const canvas = $("nca");
const ctx = canvas.getContext("2d");
let yaw = 0.6, pitch = -0.35, running = !matchMedia("(prefers-reduced-motion: reduce)").matches;
let damagedAt = null, aliveBefore = 0;

function resize() {
  const dpr = devicePixelRatio || 1;
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
}
new ResizeObserver(() => { resize(); draw(); }).observe(canvas);
resize();

function draw() {
  const pts = grid.points();
  const n = pts.length / 7;
  const c = (grid.W - 1) / 2;
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
  const scale = Math.min(canvas.width, canvas.height) / (grid.W * 1.9);
  const proj = new Float32Array(n * 3);
  const order = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    // grid y points down; flip so the planet's north is up
    const x = pts[i * 7] - c, y = -(pts[i * 7 + 1] - c), z = pts[i * 7 + 2] - c;
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const y2 = y * cp - z1 * sp, z2 = y * sp + z1 * cp;
    const persp = 1 / (1 + z2 / (grid.W * 2.2));
    proj[i * 3] = canvas.width / 2 + x1 * scale * persp;
    proj[i * 3 + 1] = canvas.height / 2 - y2 * scale * persp;
    proj[i * 3 + 2] = z2;
    order[i] = i;
  }
  order.sort((a, b) => proj[b * 3 + 2] - proj[a * 3 + 2]); // far to near
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  for (const i of order) {
    const depth = proj[i * 3 + 2] / grid.W; // -0.5 (near) .. 0.5 (far)
    const shade = 0.55 + 0.45 * (0.5 - depth);
    const r = Math.round(pts[i * 7 + 3] * 255 * shade);
    const g = Math.round(pts[i * 7 + 4] * 255 * shade);
    const b = Math.round(pts[i * 7 + 5] * 255 * shade);
    ctx.globalAlpha = pts[i * 7 + 6];
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath();
    ctx.arc(proj[i * 3], proj[i * 3 + 1], scale * 0.42 * (1.15 - depth * 0.4), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
  $("stats").textContent = `step ${grid.step} · ${n} live voxels · seed ${grid.seed}`;
  if (damagedAt !== null) {
    if (n >= aliveBefore * 0.95) {
      $("recovery").textContent = `Back to ${Math.round((n / aliveBefore) * 100)}% of its voxels in ${grid.step - damagedAt} steps.`;
      damagedAt = null;
    } else {
      $("recovery").textContent = `Healing… ${Math.round((n / aliveBefore) * 100)}% of its voxels`;
    }
  }
}

function frame() {
  if (running) {
    grid.advance(1);
    if ($("spin").checked) yaw += 0.006;
  }
  draw();
  requestAnimationFrame(frame);
}

function markDamage() {
  if (damagedAt === null) {
    aliveBefore = grid.points().length / 7;
    damagedAt = grid.step;
  }
}

function syncPlay() {
  $("play").textContent = running ? "Pause" : "Play";
  $("play").setAttribute("aria-pressed", String(running));
}

$("play").onclick = () => { running = !running; syncPlay(); };
$("reset").onclick = () => { grid.plant(); damagedAt = null; $("recovery").textContent = "Damage it to watch it heal."; };
$("punch").onclick = () => {
  markDamage();
  const c = grid.W / 2, j = () => (Math.random() - 0.5) * grid.W * 0.5;
  grid.damage(c + j(), c + j(), c + j(), grid.W * 0.22);
};
$("slice").onclick = () => {
  markDamage();
  const V = grid.voxels, plane = grid.W * grid.H;
  for (let ch = 0; ch < grid.C; ch++) grid.state.fill(0, ch * V, ch * V + plane * (grid.D >> 1));
};
$("ply").onclick = () => {
  const pts = grid.points();
  const n = pts.length / 7;
  const lines = ["ply", "format ascii 1.0", `element vertex ${n}`, "property float x", "property float y", "property float z",
    "property uchar red", "property uchar green", "property uchar blue", "end_header"];
  for (let i = 0; i < n; i++) {
    const p = pts.subarray(i * 7, i * 7 + 7);
    lines.push(`${p[0]} ${-p[1]} ${p[2]} ${Math.round(p[3] * 255)} ${Math.round(p[4] * 255)} ${Math.round(p[5] * 255)}`);
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/plain" }));
  a.download = `superparticles-${model.name}-step${grid.step}.ply`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// Drag to rotate
let drag = null;
canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY, yaw, pitch }; canvas.setPointerCapture(e.pointerId); });
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  yaw = drag.yaw + (e.clientX - drag.x) * 0.01;
  pitch = Math.max(-1.4, Math.min(1.4, drag.pitch + (e.clientY - drag.y) * 0.01));
});
canvas.addEventListener("pointerup", () => { drag = null; });

syncPlay();
requestAnimationFrame(frame);
