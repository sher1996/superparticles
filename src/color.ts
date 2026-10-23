export type RGBA = { r: number; g: number; b: number; a: number };

const fallback: RGBA = { r: 0.44, g: 0.76, b: 1.0, a: 1.0 }; // #70c1ff
let lastHex = '';
let last = fallback;

/** Parse #rgb or #rrggbb into 0..1 floats. Cached, since renderers call it every frame. */
export function hexToRgba(hex: string): RGBA {
  if (hex === lastHex) return last;
  let m = /^#?([a-f\d])([a-f\d])([a-f\d])$/i.exec(hex);
  const full = m ? `${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}` : hex.replace(/^#/, '');
  m = /^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(full);
  last = m
    ? { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255, a: 1 }
    : fallback;
  lastHex = hex;
  return last;
}
