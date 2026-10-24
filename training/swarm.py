"""Free-moving smart particles: a learned swarm (research prototype).

Grid NCAs can't move: cells are fixed and only their colours change. Here every
particle has a position *and* a state, senses the particles within a radius,
and one shared network outputs both a state change and a velocity. The swarm
is trained to assemble a target shape from a random blob and to reassemble
after part of it is scattered.

Without the position input the rule is translation invariant: the swarm builds the shape
but cannot tell *where*, and the whole shape slowly slides away (seen in training).

Perception for particle i, with weights w_ij = max(0, 1 - d_ij / R)^2 over j != i:
  own state s_i                                   (C)
  weighted mean of neighbour states               (C)
  weighted mean of (offset_x / R) * s_j            (C)   "where is which state", like Sobel x
  weighted mean of (offset_y / R) * s_j            (C)   like Sobel y
  log(1 + sum of weights)                         (1)   local density
  own position (x, y)                             (2)   where am I (like a chemical gradient)
-> MLP (4C+3 -> HIDDEN -> C+2) -> [delta state, velocity]; states are clamped to [-3, 3]
The target lives in [-1, 1]^2; a weak tether pulls every moving particle toward the
centre so none can strand itself out of sensing range. Updates are stochastic (hash mask at runtime).
"""

import math

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

C = 12          # state channels: RGB + 9 hidden
HIDDEN = 96
RADIUS = 0.22
SPEED = 0.03    # max distance per step
STATE_LIMIT = 3.0  # states are clamped to [-3, 3]; unbounded states blew up training
TETHER = 0.01      # weak pull toward the centre: stranded particles drift back into sensing range
BOUND = 1.5        # safety limit only (a hard clamp at the shape's edge trapped particles: no gradient)
FIRE_RATE = 0.5


class Swarm(nn.Module):
    def __init__(self):
        super().__init__()
        self.fc1 = nn.Linear(4 * C + 3, HIDDEN)
        self.fc2 = nn.Linear(HIDDEN, C + 2, bias=False)
        nn.init.zeros_(self.fc2.weight)

    def perceive(self, pos, state):
        # pos (B, N, 2), state (B, N, C)
        off = pos[:, None, :, :] - pos[:, :, None, :]           # (B, N, N, 2): j - i
        d = off.norm(dim=-1)
        w = F.relu(1 - d / RADIUS) ** 2
        n = pos.shape[1]
        w = w * (1 - torch.eye(n, device=pos.device))           # no self
        wsum = w.sum(-1, keepdim=True)                           # (B, N, 1)
        norm = wsum.clamp(min=1e-6)
        mean = (w @ state) / norm
        gx = ((w * off[..., 0] / RADIUS) @ state) / norm
        gy = ((w * off[..., 1] / RADIUS) @ state) / norm
        return torch.cat([state, mean, gx, gy, torch.log1p(wsum), pos], -1)

    def forward(self, pos, state, fire=None):
        out = self.fc2(F.relu(self.fc1(self.perceive(pos, state))))
        ds, v = out[..., :C], out[..., C:]
        if fire is None:
            fire = (torch.rand(pos.shape[:2], device=pos.device) <= FIRE_RATE).float()[..., None]
        # bounded step: tanh keeps the swarm stable during long rollouts
        pos = (pos + (SPEED * torch.tanh(v) - TETHER * pos) * fire).clamp(-BOUND, BOUND)
        state = (state + ds * fire).clamp(-STATE_LIMIT, STATE_LIMIT)
        return pos, state

    def param_count(self):
        return sum(p.numel() for p in self.parameters())


def blob(batch, n, generator=None, spread=0.08):
    """Start: a tight random blob in the centre, hidden channel 0 = 1, colour 0."""
    pos = torch.randn(batch, n, 2, generator=generator) * spread
    state = torch.zeros(batch, n, C)
    state[..., 3] = 1.0
    return pos, state


def scatter(pos, generator=None, frac=0.3, push=0.35):
    """Damage: push a random contiguous region's particles up to `push` away.
    (Throwing them anywhere in the world stranded them out of sensing range,
    where a particle receives no information about the shape, so training
    could never learn to bring them back.)"""
    out = pos.clone()
    b, n, _ = pos.shape
    for i in range(b):
        centre = (torch.rand(2, generator=generator) * 1.2 - 0.6)
        d = (pos[i] - centre).norm(dim=-1)
        k = int(n * frac)
        idx = d.argsort()[:k]
        ang = torch.rand(k, generator=generator) * 2 * math.pi
        rad = push * torch.rand(k, generator=generator).sqrt()
        out[i, idx] = (out[i, idx] + torch.stack([ang.cos(), ang.sin()], -1) * rad[:, None]).clamp(-1, 1)
    return out


def target_points(name: str, n_points: int = 512, seed: int = 0):
    """Sample points (and colours) uniformly from a 2D target image's opaque area."""
    from targets import TARGETS
    img = TARGETS[name](64, 4)                # (4, H, W), premultiplied
    a = img[3]
    ys, xs = np.nonzero(a > 0.5)
    rng = np.random.default_rng(seed)
    pick = rng.choice(len(xs), size=n_points, replace=len(xs) < n_points)
    xs, ys = xs[pick] + rng.uniform(-0.5, 0.5, n_points), ys[pick] + rng.uniform(-0.5, 0.5, n_points)
    pts = np.stack([xs / 31.5 - 1, ys / 31.5 - 1], -1).astype(np.float32)   # [-1, 1], y down
    col = (img[:3, ys.astype(int).clip(0, 63), xs.astype(int).clip(0, 63)] / np.maximum(a[ys.astype(int).clip(0, 63), xs.astype(int).clip(0, 63)], 1e-3)).T
    return torch.from_numpy(pts), torch.from_numpy(col.astype(np.float32))


def chamfer(pos, tpts):
    """Symmetric mean squared nearest-neighbour distance. pos (B, N, 2), tpts (M, 2)."""
    d = torch.cdist(pos, tpts[None].expand(pos.shape[0], -1, -1)) ** 2   # (B, N, M)
    return d.min(-1).values.mean(-1) + d.min(-2).values.mean(-1), d


def loss_fn(pos, state, tpts, tcol):
    ch, d = chamfer(pos, tpts)
    # colour: each particle should match the colour of its nearest target point
    nearest = d.argmin(-1)                                    # (B, N)
    col_loss = ((state[..., :3] - tcol[nearest]) ** 2).mean((-1, -2))
    return ch + 0.1 * col_loss, ch


def coverage(pos, tpts, tol=0.06):
    """Share of target points with a particle within `tol` (how complete the shape is)."""
    d = torch.cdist(pos, tpts[None].expand(pos.shape[0], -1, -1))
    return (d.min(-2).values < tol).float().mean(-1)


def hash_fire(n, step, seed):
    from nca import hash_u32
    v = hash_u32(np.arange(n, dtype=np.uint64), np.zeros(n, dtype=np.uint64), step, seed) >> np.uint64(8)
    return torch.from_numpy((v < np.uint64(int(FIRE_RATE * (1 << 24)))).astype(np.float32))[None, :, None]
