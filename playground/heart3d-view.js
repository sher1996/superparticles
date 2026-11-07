// 3D point view with the playground's particle look: round, solid, one colour (or a colour per
// particle), plus optional depth shading. Drag to turn.

const vs = `#version 300 es
in vec3 aPos;
in vec3 aCol;
uniform mat3 uRot;
uniform float uAspect;
uniform float uSize;
uniform float uDepth;
out float vShade;
out vec3 vCol;
const float F = 2.0, DIST = 3.6, NEAR = 0.1, FAR = 20.0;
void main() {
  vec3 p = uRot * aPos;
  p.y -= 0.1;                       // the heart's centre sits a little above y = 0
  float w = DIST - p.z;             // camera on +z, looking at the origin
  gl_Position = vec4(p.x * F / uAspect, p.y * F, ((w - NEAR) / (FAR - NEAR) * 2.0 - 1.0) * w, w);
  gl_PointSize = uSize * DIST / w;
  vCol = aCol;
  // nearer = brighter (off = flat colour, exactly like the playground)
  vShade = mix(1.0, clamp(1.0 - (w - DIST + 0.7) * 0.45, 0.35, 1.0), uDepth);
}`;
const fs = `#version 300 es
precision mediump float;
in vec3 vCol;
in float vShade;
out vec4 fragColor;
void main() {
  if (length(gl_PointCoord - 0.5) > 0.5) discard;
  fragColor = vec4(vCol * vShade, 1.0);
}`;

export function hexToRgb(hex) {
  const m = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : [0.44, 0.76, 1];
}

export function createView(canvas) {
  const gl = canvas.getContext("webgl2", { antialias: true });
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, vs));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(prog);
  const loc = {
    pos: gl.getAttribLocation(prog, "aPos"), rot: gl.getUniformLocation(prog, "uRot"), aspect: gl.getUniformLocation(prog, "uAspect"),
    size: gl.getUniformLocation(prog, "uSize"), col: gl.getAttribLocation(prog, "aCol"), depth: gl.getUniformLocation(prog, "uDepth"),
  };
  const bufs = [gl.createBuffer(), gl.createBuffer()], colBuf = gl.createBuffer();
  const vao = gl.createVertexArray();

  const view = { yaw: 0.6, pitch: -0.15, autoRotate: true, size: 2, color: [0.44, 0.76, 1.0], depth: true };

  /** Rotation pitch · yaw as a column-major mat3. */
  const rotation = () => {
    const cy = Math.cos(view.yaw), sy = Math.sin(view.yaw), cp = Math.cos(view.pitch), sp = Math.sin(view.pitch);
    return new Float32Array([cy, sp * sy, -cp * sy, 0, cp, sp, sy, -sp * cy, cp * cy]);
  };

  /** layers: [{ points, count, size?, color?, colors? }], drawn in order. colors: r, g, b per point. */
  view.draw = (layers) => {
    if (view.autoRotate) view.yaw += 0.004;
    const dpr = devicePixelRatio || 1;
    const w = Math.round(canvas.clientWidth * dpr), h = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(prog);
    gl.bindVertexArray(vao);
    gl.uniformMatrix3fv(loc.rot, false, rotation());
    gl.uniform1f(loc.aspect, w / h);
    gl.uniform1f(loc.depth, view.depth ? 1 : 0);
    gl.enableVertexAttribArray(loc.pos);
    layers.forEach((l, k) => {
      const col = l.color ?? view.color;
      gl.bindBuffer(gl.ARRAY_BUFFER, bufs[k % 2]);
      gl.bufferData(gl.ARRAY_BUFFER, l.points.subarray(0, l.count * 3), gl.DYNAMIC_DRAW);
      gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
      gl.uniform1f(loc.size, (l.size ?? view.size) * dpr);
      if (l.colors) {
        gl.bindBuffer(gl.ARRAY_BUFFER, colBuf);
        gl.bufferData(gl.ARRAY_BUFFER, l.colors.subarray(0, l.count * 3), gl.DYNAMIC_DRAW);
        gl.enableVertexAttribArray(loc.col);
        gl.vertexAttribPointer(loc.col, 3, gl.FLOAT, false, 0, 0);
      } else {
        gl.disableVertexAttribArray(loc.col);
        gl.vertexAttrib3f(loc.col, col[0], col[1], col[2]);
      }
      gl.drawArrays(gl.POINTS, 0, l.count);
    });
  };

  // drag to turn the heart
  let drag = null;
  canvas.addEventListener("pointerdown", (e) => { drag = { x: e.clientX, y: e.clientY }; canvas.setPointerCapture(e.pointerId); });
  canvas.addEventListener("pointermove", (e) => {
    if (!drag) return;
    view.yaw += (e.clientX - drag.x) * 0.01;
    view.pitch = Math.max(-1.2, Math.min(1.2, view.pitch + (e.clientY - drag.y) * 0.01));
    drag = { x: e.clientX, y: e.clientY };
  });
  canvas.addEventListener("pointerup", () => { drag = null; });
  return view;
}
