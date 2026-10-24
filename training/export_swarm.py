"""Export a learned swarm to superparticles-swarm v1 (+ parity vectors).

    python training/export_swarm.py training/runs/swarm-heart/checkpoint.pt models/swarm-heart.swarm.json

Weights: w1 (HIDDEN, 4C+3) over perception [state | mean | gx | gy | log1p(density) | x, y],
b1 (HIDDEN), w2 (C+2, HIDDEN) -> [delta state (C), velocity (2)]. No bias on w2.
"""

import argparse
import base64
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from swarm import BOUND, C, FIRE_RATE, HIDDEN, RADIUS, SPEED, STATE_LIMIT, TETHER, Swarm, blob, hash_fire


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--dtype", default="float16", choices=["float16", "float32"])
    args = ap.parse_args()
    ckpt_path, out_path = Path(args.checkpoint), Path(args.out)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
    cfg = ckpt["config"]
    model = Swarm()
    model.load_state_dict(ckpt["model"])
    dt = np.float16 if args.dtype == "float16" else np.float32
    q = {
        "w1": model.fc1.weight.detach().numpy().astype(dt),
        "b1": model.fc1.bias.detach().numpy().astype(dt),
        "w2": model.fc2.weight.detach().numpy().astype(dt),
    }
    blob_bytes = b"".join(q[k].tobytes() for k in ("w1", "b1", "w2"))
    metrics_path = ckpt_path.parent / "metrics.json"
    doc = {
        "format": "superparticles-swarm", "version": 1, "name": cfg["target"],
        "particles": cfg["particles"], "channels": C, "hidden": HIDDEN,
        "radius": RADIUS, "speed": SPEED, "stateLimit": STATE_LIMIT, "tether": TETHER, "bound": BOUND, "fireRate": FIRE_RATE, "dtype": args.dtype,
        "weights": {k: {"shape": list(v.shape), "data": b64(v)} for k, v in q.items()},
        "sha256": hashlib.sha256(blob_bytes).hexdigest(),
        "training": {k: cfg[k] for k in ("target", "particles", "steps", "batch", "pool", "seed", "params", "torch")},
        "metrics": json.loads(metrics_path.read_text()) if metrics_path.exists() else None,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")

    with torch.no_grad():
        model.fc1.weight.copy_(torch.from_numpy(q["w1"].astype(np.float32)))
        model.fc1.bias.copy_(torch.from_numpy(q["b1"].astype(np.float32)))
        model.fc2.weight.copy_(torch.from_numpy(q["w2"].astype(np.float32)))
        n, seed = 48, 777
        g = torch.Generator().manual_seed(5)
        pos, st = blob(1, n, g)
        p0, s0 = pos.clone(), st.clone()
        for s in range(12):
            pos, st = model(pos, st, hash_fire(n, s, seed))
    vec = {"particles": n, "seed": seed, "steps": 12,
           "pos": b64(p0[0].numpy()), "state": b64(s0[0].numpy()),
           "outPos": b64(pos[0].numpy()), "outState": b64(st[0].numpy())}
    vp = out_path.with_name(out_path.name.replace(".swarm.json", ".swarm-vectors.json"))
    vp.write_text(json.dumps(vec))
    print(f"wrote {vp}")


if __name__ == "__main__":
    main()
