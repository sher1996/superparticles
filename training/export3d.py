"""Export a 3D voxel NCA checkpoint (superparticles-nca v1, dims 3), parity vectors,
and optionally a PLY point-cloud sequence for Blender/MeshLab.

    python training/export3d.py training/runs/planet3d/checkpoint.pt models/planet3d.nca.json [--ply DIR]

Weights: w1 (hidden, 4C) with perception index 4c + k, k in [identity, sobel_x, sobel_y, sobel_z].
"""

import argparse
import base64
import hashlib
import json
from pathlib import Path

import numpy as np
import torch

from nca import ALIVE_THRESHOLD
from nca3d import NCA3D, hash_fire_mask3d, seed_state


def b64(a):
    return base64.b64encode(np.ascontiguousarray(a).tobytes()).decode()


def write_ply(path: Path, x: torch.Tensor):
    """Live voxels as coloured points (un-premultiplied RGB)."""
    s = x[0].numpy()
    a = np.clip(s[3], 0, 1)
    zz, yy, xx = np.nonzero(a > ALIVE_THRESHOLD)
    rgb = np.clip(s[:3, zz, yy, xx] / np.maximum(a[zz, yy, xx], 1e-3), 0, 1).T
    lines = [f"{px} {-py} {pz} {int(r * 255)} {int(g * 255)} {int(b * 255)}" for px, py, pz, (r, g, b) in zip(xx, yy, zz, rgb)]
    header = ["ply", "format ascii 1.0", f"element vertex {len(lines)}",
              "property float x", "property float y", "property float z",
              "property uchar red", "property uchar green", "property uchar blue", "end_header"]
    path.write_text("\n".join(header + lines) + "\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("checkpoint")
    ap.add_argument("out")
    ap.add_argument("--dtype", default="float16", choices=["float16", "float32"])
    ap.add_argument("--ply", help="write a PLY sequence (grow, damage, heal) into this directory")
    args = ap.parse_args()

    ckpt_path, out_path = Path(args.checkpoint), Path(args.out)
    ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
    cfg = ckpt["config"]
    model = NCA3D()
    model.load_state_dict(ckpt["model"])
    np_dtype = np.float16 if args.dtype == "float16" else np.float32
    q = {
        "w1": model.fc1.weight.detach().numpy()[:, :, 0, 0, 0].astype(np_dtype),
        "b1": model.fc1.bias.detach().numpy().astype(np_dtype),
        "w2": model.fc2.weight.detach().numpy()[:, :, 0, 0, 0].astype(np_dtype),
    }
    blob = b"".join(q[k].tobytes() for k in ("w1", "b1", "w2"))
    metrics_path = ckpt_path.parent / "metrics.json"
    size = cfg["size"]
    doc = {
        "format": "superparticles-nca", "version": 1, "name": cfg["target"], "dims": 3,
        "channels": model.channels, "hidden": model.hidden, "perception": "identity+sobel3x3x3",
        "fireRate": model.fire_rate, "aliveThreshold": ALIVE_THRESHOLD,
        "grid": {"width": size, "height": size, "depth": size}, "seed": "center", "dtype": args.dtype,
        "weights": {k: {"shape": list(v.shape), "data": b64(v)} for k, v in q.items()},
        "sha256": hashlib.sha256(blob).hexdigest(),
        "training": {k: cfg[k] for k in ("target", "size", "steps", "batch", "pool", "damage", "seed", "params", "torch")},
        "metrics": json.loads(metrics_path.read_text()) if metrics_path.exists() else None,
    }
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(doc))
    print(f"wrote {out_path} ({out_path.stat().st_size} bytes)")

    with torch.no_grad():
        model.fc1.weight.copy_(torch.from_numpy(q["w1"].astype(np.float32))[:, :, None, None, None])
        model.fc1.bias.copy_(torch.from_numpy(q["b1"].astype(np.float32)))
        model.fc2.weight.copy_(torch.from_numpy(q["w2"].astype(np.float32))[:, :, None, None, None])

        vs, seed = 8, 4321
        x = seed_state(1, vs)
        for s in range(20):
            x = model(x, hash_fire_mask3d(vs, s, seed))
        inp = x.clone()
        for s in range(20, 26):
            x = model(x, hash_fire_mask3d(vs, s, seed))
        vec = {"size": vs, "seed": seed, "startStep": 20, "steps": 6,
               "input": b64(inp[0].numpy().astype(np.float32)), "output": b64(x[0].numpy().astype(np.float32))}
        vp = out_path.with_name(out_path.name.replace(".nca.json", ".vectors.json"))
        vp.write_text(json.dumps(vec))
        print(f"wrote {vp}")

        if args.ply:
            d = Path(args.ply)
            d.mkdir(parents=True, exist_ok=True)
            x = seed_state(1, size)
            frame = 0
            for s in range(160):
                x = model(x, hash_fire_mask3d(size, s, 7))
                if s % 8 == 7:
                    write_ply(d / f"frame_{frame:03d}.ply", x)
                    frame += 1
            x[:, :, : size // 2] = 0  # cut away the front half
            for s in range(160, 320):
                x = model(x, hash_fire_mask3d(size, s, 7))
                if s % 8 == 7:
                    write_ply(d / f"frame_{frame:03d}.ply", x)
                    frame += 1
            print(f"wrote {frame} PLY frames to {d}")


if __name__ == "__main__":
    main()
