// Colours for the 3D particle pages: each follower takes a colour from where it is.
//   single    one colour (the colour picker)
//   gradient  bottom → top between two colours
//   rainbow   hue around the shape, a little lighter towards the top
//   picture   the picture's own colours, projected through the shape from the front
//             (the side the picture shows; the back gets the same colours, seen through)

const SIZE = 256; // the picture is kept at this many pixels on its long side

/**
 * The picture's colours (DOM only): cut out like imageToMask / cutOutPng, cropped to the object,
 * and with the background filled from the nearest object pixel, so a particle on the shape's edge
 * never picks up background colour.
 */
export function pictureColors(image, tolerance = 60) {
  const s = Math.min(1, SIZE / Math.max(image.width, image.height));
  const W = Math.max(1, Math.round(image.width * s)), H = Math.max(1, Math.round(image.height * s));
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(image, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  let transparent = false;
  for (let i = 3; i < px.length; i += 4) if (px[i] < 128) { transparent = true; break; }
  const bg = [px[0], px[1], px[2]];
  const on = new Uint8Array(W * H);
  let x0 = W, x1 = -1, y0 = H, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = y * W + x, o = 4 * i;
    const inside = transparent ? px[o + 3] >= 128 : Math.abs(px[o] - bg[0]) + Math.abs(px[o + 1] - bg[1]) + Math.abs(px[o + 2] - bg[2]) > tolerance;
    if (!inside) continue;
    on[i] = 1;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  if (x1 < 0) return null;
  const rgb = new Float32Array(W * H * 3);
  for (let i = 0; i < W * H; i++) if (on[i]) for (let k = 0; k < 3; k++) rgb[3 * i + k] = px[4 * i + k] / 255;
  // grow the object's colours outwards, one ring of pixels per pass, until every pixel has one
  let front = on;
  for (let pass = 0; pass < W + H; pass++) {
    const next = front.slice();
    let grew = 0;
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (front[i]) continue;
      let r = 0, gg = 0, b = 0, n = 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= W || Y >= H || !front[Y * W + X]) continue;
        const j = 3 * (Y * W + X);
        r += rgb[j]; gg += rgb[j + 1]; b += rgb[j + 2]; n++;
      }
      if (n) { rgb[3 * i] = r / n; rgb[3 * i + 1] = gg / n; rgb[3 * i + 2] = b / n; next[i] = 1; grew++; }
    }
    front = next;
    if (!grew) break;
  }
  return { w: W, h: H, rgb, box: [x0, x1 + 1, y0, y1 + 1] };
}

/** The shape's extent from its surface samples: [x0, x1, y0, y1, z0, z1]. */
export function surfaceBox(points) {
  const b = [Infinity, -Infinity, Infinity, -Infinity, Infinity, -Infinity];
  for (let i = 0; i < points.length; i += 3) for (let k = 0; k < 3; k++) {
    const v = points[i + k];
    if (v < b[2 * k]) b[2 * k] = v;
    if (v > b[2 * k + 1]) b[2 * k + 1] = v;
  }
  return b;
}

function hsl(h, s, l) {
  const f = (n) => {
    const k = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/**
 * A painter for one shape: paint(points, count, out) writes r, g, b per point into out.
 * opts: { mode, color, color2, picture, box } — box from surfaceBox of the target surface.
 */
export function createPainter({ mode = "single", color = [0.44, 0.76, 1], color2 = [1, 0.4, 0.7], picture = null, box }) {
  const [x0, x1, y0, y1] = box;
  const cx = (x0 + x1) / 2;
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  if (mode === "picture" && picture) {
    // the object's box in the picture ↔ the shape's box seen from the front (picture rows run down)
    const { w, h, rgb } = picture, [px0, px1, py0, py1] = picture.box;
    const sx = (px1 - px0) / (x1 - x0), sy = (py1 - py0) / (y1 - y0);
    return (points, count, out) => {
      for (let i = 0; i < count; i++) {
        const u = Math.min(w - 1, Math.max(0, Math.floor(px0 + (points[3 * i] - x0) * sx)));
        const v = Math.min(h - 1, Math.max(0, Math.floor(py1 - (points[3 * i + 1] - y0) * sy)));
        const j = 3 * (v * w + u);
        out[3 * i] = rgb[j]; out[3 * i + 1] = rgb[j + 1]; out[3 * i + 2] = rgb[j + 2];
      }
    };
  }
  if (mode === "gradient") {
    return (points, count, out) => {
      for (let i = 0; i < count; i++) {
        const t = clamp01((points[3 * i + 1] - y0) / (y1 - y0));
        for (let k = 0; k < 3; k++) out[3 * i + k] = color2[k] + (color[k] - color2[k]) * t;
      }
    };
  }
  if (mode === "rainbow") {
    return (points, count, out) => {
      for (let i = 0; i < count; i++) {
        const a = Math.atan2(points[3 * i + 2], points[3 * i] - cx) / (2 * Math.PI) + 0.5;
        const t = clamp01((points[3 * i + 1] - y0) / (y1 - y0));
        const c = hsl(a, 0.85, 0.5 + 0.15 * t);
        out[3 * i] = c[0]; out[3 * i + 1] = c[1]; out[3 * i + 2] = c[2];
      }
    };
  }
  return (points, count, out) => {
    for (let i = 0; i < count; i++) { out[3 * i] = color[0]; out[3 * i + 1] = color[1]; out[3 * i + 2] = color[2]; }
  };
}
