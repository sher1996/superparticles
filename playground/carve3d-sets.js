// Built-in view sets for the carving page: plain silhouettes drawn on a canvas, then turned into
// masks exactly like an uploaded image. Each view is drawn in its own image plane (a right, b up):
//   front: a = x, b = y      side (from the right): a = −z, b = y      top: a = x, b = −z
// so on a side image the object's front is on the left, on a top image it is at the bottom.

const SIZE = 128, EXT = 1.15;

/** A transparent canvas with a black silhouette painted in world-ish units (−1.15..1.15, y up). */
export function drawView(paint) {
  const c = document.createElement("canvas");
  c.width = c.height = SIZE;
  const g = c.getContext("2d");
  g.translate(SIZE / 2, SIZE / 2);
  g.scale(SIZE / (2 * EXT), -SIZE / (2 * EXT));
  g.fillStyle = "#000";
  paint(g);
  return c;
}

const poly = (g, pts) => {
  g.beginPath();
  pts.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
  g.closePath();
  g.fill();
};
const ellipse = (g, cx, cy, rx, ry) => { g.beginPath(); g.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); g.fill(); };

function heart(g) {
  const pts = [];
  for (let k = 0; k < 200; k++) {
    const t = (k / 200) * Math.PI * 2;
    pts.push([(16 * Math.sin(t) ** 3) / 17, (13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t)) / 17 + 0.1]);
  }
  poly(g, pts);
}

// mug: body x −0.55..0.35, y −0.7..0.6, z −0.45..0.45 (round in the top view); handle on +x
const MUG = { x0: -0.55, x1: 0.35, y0: -0.7, y1: 0.6, r: 0.45, hx: 0.55, ho: 0.36, hi: 0.2 };

// vase: half-width at each height
const vaseR = (y) => 0.2 + 0.36 * Math.exp(-(((y + 0.25) / 0.42) ** 2)) + (y > 0.72 ? 0.1 : 0);
function vaseProfile(g) {
  const pts = [];
  for (let k = 0; k <= 60; k++) { const y = -0.9 + (1.8 * k) / 60; pts.push([vaseR(y), y]); }
  for (let k = 60; k >= 0; k--) { const y = -0.9 + (1.8 * k) / 60; pts.push([-vaseR(y), y]); }
  poly(g, pts);
}
let vaseMax = 0;
for (let y = -0.9; y <= 0.9; y += 0.01) vaseMax = Math.max(vaseMax, vaseR(y));

export const SETS = {
  heart: {
    label: "Heart (front) + ellipse (side)",
    views: {
      front: heart,
      side: (g) => ellipse(g, 0, 0.05, 0.42, 0.85),
    },
  },
  house: {
    label: "House: front, side, top",
    views: {
      front: (g) => poly(g, [[-0.7, -0.8], [0.7, -0.8], [0.7, 0.15], [0.85, 0.15], [0, 0.85], [-0.85, 0.15], [-0.7, 0.15]]),
      side: (g) => poly(g, [[-0.95, -0.8], [0.95, -0.8], [0.95, 0.85], [-0.95, 0.85]]),
      top: (g) => poly(g, [[-0.85, -0.95], [0.85, -0.95], [0.85, 0.95], [-0.85, 0.95]]),
    },
  },
  mug: {
    label: "Mug: front, side, top",
    views: {
      front: (g) => {
        poly(g, [[MUG.x0, MUG.y0], [MUG.x1, MUG.y0], [MUG.x1, MUG.y1], [MUG.x0, MUG.y1]]);
        g.beginPath();
        g.arc(MUG.hx, -0.05, MUG.ho, 0, Math.PI * 2);
        g.arc(MUG.hx, -0.05, MUG.hi, 0, Math.PI * 2, true);
        g.fill();
      },
      side: (g) => poly(g, [[-MUG.r, MUG.y0], [MUG.r, MUG.y0], [MUG.r, MUG.y1], [-MUG.r, MUG.y1]]),
      top: (g) => {
        ellipse(g, (MUG.x0 + MUG.x1) / 2, 0, MUG.r, MUG.r);
        poly(g, [[MUG.x1 - 0.05, -0.07], [MUG.hx + MUG.ho, -0.07], [MUG.hx + MUG.ho, 0.07], [MUG.x1 - 0.05, 0.07]]);
      },
    },
  },
  vase: {
    label: "Vase: front, side, top",
    views: {
      front: vaseProfile,
      side: vaseProfile,
      top: (g) => ellipse(g, 0, 0, vaseMax, vaseMax),
    },
  },
};
