// The AI depth model: Depth Anything V2 Small, run in the browser by transformers.js.
// Nothing here is loaded until loadDepthModel() is called (the library itself is imported
// dynamically, through the page's import map), so the rest of the site never touches it.

export const MODEL_ID = "onnx-community/depth-anything-v2-small";
export const LIB_VERSION = "4.3.2";

// File sizes on huggingface.co (onnx/ folder of the model repo), for the "what will be downloaded" note.
export const MODEL_FILES = {
  fp16: { file: "onnx/model_fp16.onnx", mb: 49.6, label: "half precision" },
  fp32: { file: "onnx/model.onnx", mb: 99.1, label: "full precision" },
  q8: { file: "onnx/model_quantized.onnx", mb: 27.3, label: "8-bit" },
};

/** Which device and file this browser will use. WebGPU with fp16 if it can, else WebAssembly + 8-bit. */
export async function pickBackend() {
  try {
    if (navigator.gpu) {
      const adapter = await navigator.gpu.requestAdapter();
      if (adapter) return { device: "webgpu", dtype: adapter.features.has("shader-f16") ? "fp16" : "fp32" };
    }
  } catch {}
  return { device: "wasm", dtype: "q8" };
}

let pipe = null;

/**
 * Download (or take from the browser cache) the library and the model, and get it ready.
 * onProgress({ file, loaded, total }) is called while files come in.
 */
export async function loadDepthModel({ device, dtype }, onProgress) {
  const t0 = performance.now();
  const { pipeline, env } = await import("@huggingface/transformers");
  env.allowLocalModels = false; // never look for models on this site's own server
  const files = new Map();
  pipe = await pipeline("depth-estimation", MODEL_ID, {
    device,
    dtype,
    progress_callback: (p) => {
      if (p.status === "progress" || p.status === "done") {
        const f = files.get(p.file) ?? { loaded: 0, total: 0 };
        if (p.total) f.total = p.total;
        f.loaded = p.status === "done" ? f.total || f.loaded : p.loaded ?? f.loaded;
        files.set(p.file, f);
        let loaded = 0, total = 0;
        for (const v of files.values()) { loaded += v.loaded; total += v.total; }
        onProgress?.({ file: p.file, loaded, total });
      }
    },
  });
  return { ms: performance.now() - t0, files: [...files].map(([file, f]) => ({ file, bytes: f.total })) };
}

/**
 * Guess the depth of every pixel. canvas: the picture. Returns { data: Float32Array, w, h, ms }
 * at the picture's size; larger values = nearer (the model predicts relative inverse depth).
 */
export async function estimateDepth(canvas) {
  if (!pipe) throw new Error("The depth model isn't loaded yet.");
  const blob = await new Promise((res) => canvas.toBlob(res, "image/png"));
  const url = URL.createObjectURL(blob);
  try {
    const t0 = performance.now();
    const out = await pipe(url);
    const ms = performance.now() - t0;
    const [h, w] = out.predicted_depth.dims;
    return { data: Float32Array.from(out.predicted_depth.data), w, h, ms };
  } finally {
    URL.revokeObjectURL(url);
  }
}
