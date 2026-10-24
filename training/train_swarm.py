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
from swarm import SPEED, Swarm, blob, coverage, hash_fire, loss_fn, scatter, target_points


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
    ap.add_argument("--reseed", type=int, default=1, help="fresh blobs per batch")
    ap.add_argument("--window", type=int, default=8, help="score the shape over the last N steps, so it must hold still")
    ap.add_argument("--still", type=float, default=0.5, help="weight of the movement penalty over that window")
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
    best_cov = -1.0  # best.pt = highest coverage after 150 steps from a fixed blob
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
        win_loss, win_ch, moved = 0.0, 0.0, 0.0
        for i in range(n):
            prev = pos
            pos, st = model(pos, st)
            if i >= n - args.window:
                l, c = loss_fn(pos, st, tpts, tcol)
                win_loss, win_ch = win_loss + l.mean(), win_ch + c
                moved = moved + ((pos - prev) ** 2).sum(-1).mean() / SPEED ** 2
        ch = win_ch / args.window
        loss = win_loss / args.window + args.still * 1e-3 * moved / args.window
        opt.zero_grad()
        loss.backward()
        with torch.no_grad():
            for p in model.parameters():
                if p.grad is not None:
                    p.grad /= p.grad.norm() + 1e-8
        opt.step()
        with torch.no_grad():
            pos_pool[idx], st_pool[idx] = pos.detach(), st.detach()
        # Pick the saved model by the real goal: grow a fixed blob for 150 steps with the
        # runtime's hashed mask and measure coverage (the training loss is too noisy for this)
        if step % 100 == 99:
            with torch.no_grad():
                ep, es = blob(1, args.particles, torch.Generator().manual_seed(123))
                for s_ in range(150):
                    ep, es = model(ep, es, hash_fire(args.particles, s_, 7))
                score = coverage(ep, tpts).item()
            print(json.dumps({"step": step, "eval_coverage_150": round(score, 4)}), flush=True)
            log.write(json.dumps({"step": step, "eval_coverage_150": round(score, 4)}) + "\n")
            if score > best_cov:
                best_cov = score
                torch.save({"model": model.state_dict(), "step": step, "config": config, "eval_coverage_150": score}, out / "best.pt")
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
