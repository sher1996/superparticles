"""Export a trained checkpoint to the SuperParticles NCA model format (JSON, version 1).

    python training/export.py training/runs/heart/checkpoint.pt models/heart.nca.json

Format (all tensors row-major, little-endian, base64):
  w1: (hidden, 3*channels)   perception index = 3*c + k, k in [identity, sobel_x, sobel_y]
  b1: (hidden,)
  w2: (channels, hidden)
  update = w2 @ relu(w1 @ perception + b1); fire mask from hash_u32 (see nca.py)

Also writes <name>.vectors.json: a small input state and the exact output after a few
seeded steps, computed with the *dequantised* weights, so runtimes can prove parity.
"""

import base64
import hashlib
import json
import sys
from pathlib import Path

import numpy as np
import torch

from nca import ALIVE_THRESHOLD, NCA, hash_fire_mask, seed_state


def b64(a: np.ndarray) -> str:
    return base64.b64encode(np.ascontiguousarray(a).astype("<" + a.dtype.str[1:]).tobytes()).decode()


def main() -> None:
    ckpt_path, out_path = Path(sys.argv[1]), Path(sys.argv[2])
    dtype = sys.argv[3] if len(sys.argv) > 3 else "float16"
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoints
    cfg = ckpt["config"]
    model = NCA()
    model.load_state_dict(ckpt["model"])

    raw = {
        "w1": model.fc1.weight.detach().numpy()[:, :, 0, 0],
        "b1": model.fc1.bias.detach().numpy(),
        "w2": model.fc2.weight.detach().numpy()[:, :, 0, 0],
    }
    np_dtype = np.float16 if dtype == "float16" else np.float32
    q = {k: v.astype(np_dtype) for k, v in raw.items()}
    blob = b"".join(q[k].tobytes() for k in ("w1", "b1", "w2"))

    metrics_path = ckpt_path.parent / "metrics.json"
    doc = {
        "format": "superparticles-nca",
        "version": 1,
        "name": cfg["target"],
        "channels": model.channels,
        "hidden": model.hidden,
        "perception": "identity+sobel3x3",
        "fireRate": model.fire_rate,
        "aliveThreshold": ALIVE_THRESHOLD,
        "grid": {"width": cfg["size"], "height": cfg["size"]},
        "seed": "center",
        "dtype": dtype,
        "weights": {k: {"shape": list(v.shape), "data": b64(v)} for k, v in q.items()},
        "sha256": hashlib.sha256(blob).hexdigest(),
        "training": {k: cfg[k] for k in ("target", "size", "pad", "steps", "batch", "pool", "damage", "seed", "params", "torch")},
        "metrics": json.loads(metrics_path.read_text()) if metrics_path.exists() else None,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes, {len(blob)} weight bytes, sha256 {doc['sha256'][:12]})")

    # Parity vectors with dequantised weights
    with torch.no_grad():
        model.fc1.weight.copy_(torch.from_numpy(q["w1"].astype(np.float32))[:, :, None, None])
        model.fc1.bias.copy_(torch.from_numpy(q["b1"].astype(np.float32)))
        model.fc2.weight.copy_(torch.from_numpy(q["w2"].astype(np.float32))[:, :, None, None])
        size, seed, start, steps = 24, 1234, 0, 8
        x = seed_state(1, size)
        # grow a little first so the vector exercises non-trivial values
        for s in range(40):
            x = model(x, hash_fire_mask(size, size, s, seed))
        inp = x.clone()
        for s in range(40, 40 + steps):
            x = model(x, hash_fire_mask(size, size, s, seed))
    vec = {
        "size": size, "seed": seed, "startStep": 40, "steps": steps,
        "input": b64(inp[0].numpy().astype(np.float32)),   # (C, H, W)
        "output": b64(x[0].numpy().astype(np.float32)),
        "maskStep40": b64(hash_fire_mask(size, size, 40, seed)[0, 0].numpy().astype(np.uint8)),
    }
    vec_path = out_path.with_name(out_path.name.replace(".nca.json", ".vectors.json"))
    vec_path.write_text(json.dumps(vec))
    print(f"wrote {vec_path}")


if __name__ == "__main__":
    main()
