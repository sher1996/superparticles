"""Train a learned swarm (free-moving smart particles) to assemble a target.

    python training/train_swarm.py --target heart --particles 256 --steps 2000 --out training/runs/swarm-heart
"""

import argparse
import json
import random
import time
from pathlib import Path

import numpy as np
import torch

from nca import lr_schedule
from swarm import Swarm, blob, loss_fn, scatter, target_points


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default="heart")
    ap.add_argument("--particles", type=int, default=256)
    ap.add_argument("--steps", type=int, default=2000)
    ap.add_argument("--batch", type=int, default=4)
    ap.add_argument("--pool", type=int, default=128)
    ap.add_argument("--rollout", type=int, nargs=2, default=[48, 72])
    ap.add_argument("--lr", type=float, default=2e-3)
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--out", default="training/runs/swarm-heart")
    ap.add_argument("--resume", action="store_true")
    ap.add_argument("--reseed", type=int, default=2, help="fresh blobs per batch (keeps the pool from filling with tangled states)")
    args = ap.parse_args()

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    gen = torch.Generator().manual_seed(args.seed + 1)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    tpts, tcol = target_points(args.target)
    model = Swarm()
    opt = torch.optim.Adam(model.parameters(), lr=args.lr)
    pos_pool, st_pool = blob(args.pool, args.particles, gen)
    config = {**vars(args), "kind": "swarm", "params": model.param_count(), "torch": str(torch.__version__)}
    (out / "config.json").write_text(json.dumps(config, indent=2))
    print(json.dumps(config), flush=True)

    start = 0
    ckpt_path = out / "checkpoint.pt"
    if args.resume and ckpt_path.exists():
        ckpt = torch.load(ckpt_path, map_location="cpu", weights_only=False)  # our own checkpoint
        model.load_state_dict(ckpt["model"])
        opt.load_state_dict(ckpt["opt"])
        start = ckpt["step"] + 1

    log = open(out / "log.jsonl", "a")
    t0 = time.time()
    recent, best = [], float("inf")  # keep the checkpoint with the best recent Chamfer, not just the last
    for step in range(start, args.steps):
        for g in opt.param_groups:
            g["lr"] = lr_schedule(step, args.steps, args.lr)
        idx = torch.randint(0, args.pool, (args.batch,), generator=gen)
        pos, st = pos_pool[idx].clone(), st_pool[idx].clone()
        with torch.no_grad():
            per, _ = loss_fn(pos, st, tpts, tcol)
            order = per.argsort(descending=True)
            pos, st, idx = pos[order], st[order], idx[order]
            p0, s0 = blob(args.reseed, args.particles, gen)
            pos[:args.reseed], st[:args.reseed] = p0, s0  # worst -> fresh blobs
            if step > 200:
                pos[-1:] = scatter(pos[-1:], gen)        # best -> scattered (learn to reassemble)
        n = random.randint(*args.rollout)
        for _ in range(n):
            pos, st = model(pos, st)
        loss, ch = loss_fn(pos, st, tpts, tcol)
        loss = loss.mean()
        opt.zero_grad()
        loss.backward()
        with torch.no_grad():
            for p in model.parameters():
                if p.grad is not None:
                    p.grad /= p.grad.norm() + 1e-8
        opt.step()
        with torch.no_grad():
            pos_pool[idx], st_pool[idx] = pos.detach(), st.detach()
        recent = (recent + [ch.mean().item()])[-50:]
        if step >= 300 and len(recent) == 50 and sum(recent) / 50 < best:
            best = sum(recent) / 50
            torch.save({"model": model.state_dict(), "step": step, "config": config, "recent_chamfer": best}, out / "best.pt")
        if step % 20 == 0 or step == args.steps - 1:
            rec = {"step": step, "loss": loss.item(), "chamfer": ch.mean().item(), "iters": n, "elapsed": round(time.time() - t0, 1)}
            log.write(json.dumps(rec) + "\n")
            log.flush()
            print(json.dumps(rec), flush=True)
        if step % 100 == 0 or step == args.steps - 1:
            tmp = out / "checkpoint.tmp"
            torch.save({"model": model.state_dict(), "opt": opt.state_dict(), "step": step, "config": config}, tmp)
            tmp.replace(ckpt_path)
    print(f"done in {time.time() - t0:.0f}s")


if __name__ == "__main__":
    main()
