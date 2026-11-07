"""Local image → 3D helper for the orchestrated swarm pages.

Runs TripoSG (MIT, https://github.com/VAST-AI-Research/TripoSG) on this computer's GPU and
answers on http://127.0.0.1:8765 only (nothing leaves the machine):

    GET  /status     {"ready": bool, "loaded": bool, "device": ..., "weights": bool}
    POST /generate   body: a PNG with a transparent background (the page cuts it out)
                     reply: 4-byte little-endian header length, a JSON header
                     {"res": R, "bounds": [lo, hi], "layout": "x,y,z", "seconds": ...},
                     then R³ float16 signed distances (negative inside, world units).

The swarm pages use the distance grid directly (no mesh): every smart particle can feel the
surface, and thin parts survive as long as they are wider than one cell (2.0 / R).

    tools/image3d/.venv/Scripts/python tools/image3d/server.py
"""

import io
import json
import os
import sys
import tempfile
import time
import types
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Lock

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(HERE, "TripoSG")
WEIGHTS = os.path.join(HERE, "pretrained_weights", "TripoSG")
PORT = 8765
RES = 256          # grid cells per axis: 256³ ≈ 16.8 M queries, ~0.008 per cell
BOUNDS = 1.005     # TripoSG's own default bounding box

# diso (a CUDA-compiled marching-cubes package) is only used by TripoSG's optional fast
# decoder; we never build a mesh, so a stand-in keeps the import working without compiling it.
sys.modules.setdefault("diso", types.SimpleNamespace(DiffDMC=None))
sys.path[:0] = [REPO, os.path.join(REPO, "scripts")]

state = {"pipe": None, "error": None}
lock = Lock()


def load():
    import torch
    from triposg.pipelines import pipeline_triposg
    from triposg.pipelines.pipeline_triposg import TripoSGPipeline
    # newer diffusers only loads components from modules that are already imported
    import triposg.schedulers.scheduling_rectified_flow  # noqa: F401
    import triposg.models.transformers.triposg_transformer  # noqa: F401
    import triposg.models.autoencoders.autoencoder_kl_triposg  # noqa: F401

    if state["pipe"] is None:
        pipe = TripoSGPipeline.from_pretrained(WEIGHTS).to("cuda", torch.float16)
        state["pipe"] = pipe
        state["module"] = pipeline_triposg
    return state["pipe"]


def distance_grid(logits):
    """TripoSG's decoder values (< 0 inside, checked on its example pictures) → signed distance in
    world units (< 0 inside)."""
    from scipy import ndimage

    inside = logits < 0
    cell = 2 * BOUNDS / (RES - 1)
    out = ndimage.distance_transform_edt(~inside)   # outside: distance to the nearest inside cell
    into = ndimage.distance_transform_edt(inside)   # inside: distance to the nearest outside cell
    return ((out - into) - np.where(inside, -0.5, 0.5)) * cell


def generate(png_bytes, steps=50, guidance=7.0, seed=42):
    import torch
    from image_process import prepare_image

    pipe = load()
    captured = {}

    def capture_grid(geometric_func, device, bounds, dense_octree_depth, hierarchical_octree_depth):
        # instead of TripoSG's mesh extraction: query the decoder on a dense grid and keep the values
        from triposg.inference_utils import generate_dense_grid_points_gpu

        lo = torch.tensor([-BOUNDS] * 3, device=device)
        hi = torch.tensor([BOUNDS] * 3, device=device)
        xyz, size, _ = generate_dense_grid_points_gpu(lo, hi, octree_depth=int(np.log2(RES)), indexing="ij")
        chunks = []
        for part in torch.split(xyz, 2 ** 21):
            chunks.append(geometric_func(part.unsqueeze(0)).float().view(-1).cpu())
        captured["logits"] = torch.cat(chunks).view(*size).numpy()
        return [(np.zeros((3, 3), np.float32), np.array([[0, 1, 2]]))]  # a stand-in mesh, unused

    with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as f:
        f.write(png_bytes)
        path = f.name
    try:
        img = prepare_image(path, bg_color=np.array([1.0, 1.0, 1.0]), rmbg_net=None)
        if isinstance(img, str):
            raise ValueError(img)
        t0 = time.time()
        original = state["module"].hierarchical_extract_geometry
        state["module"].hierarchical_extract_geometry = capture_grid
        try:
            with torch.no_grad():
                pipe(image=img, generator=torch.Generator(device="cuda").manual_seed(seed),
                     num_inference_steps=steps, guidance_scale=guidance, use_flash_decoder=False)
        finally:
            state["module"].hierarchical_extract_geometry = original
        sdf = distance_grid(captured["logits"])
        # TripoSG's input camera sits on +x with the picture's left on +z; the pages' camera sits
        # on +z with x to the right. Turn the grid so the picture's view faces the page:
        # page (x, y, z) = TripoSG (-z, y, x).
        sdf = np.ascontiguousarray(sdf.transpose(2, 1, 0)[::-1])
        torch.cuda.empty_cache()
        return sdf.astype(np.float16), time.time() - t0
    finally:
        os.unlink(path)


class Handler(BaseHTTPRequestHandler):
    def cors(self):
        # only the local playground may call this
        origin = self.headers.get("Origin", "")
        if origin.startswith("http://localhost:") or origin.startswith("http://127.0.0.1:"):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def do_OPTIONS(self):
        self.send_response(204)
        self.cors()
        self.end_headers()

    def do_GET(self):
        if self.path != "/status":
            self.send_error(404)
            return
        import torch

        body = json.dumps({
            "ready": True,
            "loaded": state["pipe"] is not None,
            "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else None,
            "weights": os.path.isdir(WEIGHTS),
            "res": RES,
        }).encode()
        self.send_response(200)
        self.cors()
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/generate":
            self.send_error(404)
            return
        data = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        try:
            with lock:  # one at a time: the GPU has room for one
                sdf, seconds = generate(data)
            header = json.dumps({"res": RES, "bounds": [-BOUNDS, BOUNDS], "layout": "x,y,z", "seconds": round(seconds, 1)}).encode()
            payload = len(header).to_bytes(4, "little") + header + sdf.tobytes()
            self.send_response(200)
            self.cors()
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
        except Exception as e:  # report it to the page instead of dropping the connection
            body = json.dumps({"error": f"{type(e).__name__}: {e}"}).encode()
            self.send_response(500)
            self.cors()
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

    def log_message(self, fmt, *args):
        sys.stderr.write("[image3d] " + fmt % args + "\n")


if __name__ == "__main__":
    if not os.path.isdir(WEIGHTS):
        print(f"TripoSG weights not found in {WEIGHTS}. Download them first (see README.md).")
    # on Windows, address reuse lets a second copy share the port and answer with old code
    ThreadingHTTPServer.allow_reuse_address = False
    try:
        server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    except OSError:
        sys.exit(f"Port {PORT} is busy: the helper is probably already running.")
    print(f"image -> 3D helper on http://127.0.0.1:{PORT}  (Ctrl+C to stop)")
    server.serve_forever()
