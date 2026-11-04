"""Learn from your Approve / Reject decisions.

Two simple, explainable mechanisms:

1. Feature preferences. Every opportunity has features (AliExpress category,
   keyword words, price band, profit band, size, printable, competition level,
   trend stage). For each feature we count approvals vs rejections and compute a
   smoothed log-odds. A new opportunity's preference is the average over its
   features, turned into a score adjustment of up to +/-15 points (scaled by
   'learning_strength').

2. Reasons. Words in your reasons nudge the weights of the score parts:
   "margin too low" -> profit counts more, "too much competition" ->
   competition counts more, "too late / hype" -> earliness counts more,
   "wrong match" -> match counts more. Weights move at most 0.6x - 1.6x.
"""
from __future__ import annotations

import math
import sqlite3
from collections import defaultdict
from typing import Any

from ..db import loads
from .scoring import PARTS
from .text import content_tokens

REASON_WORDS: dict[str, list[str]] = {
    "profit": ["margin", "marge", "profit", "winst", "cheap", "goedkoop", "price", "prijs", "duur",
               "expensive", "cost", "kosten", "money", "verdien"],
    "competition": ["competition", "concurrentie", "concurrent", "sellers", "verkopers", "reviews",
                    "saturated", "verzadigd", "crowded", "druk", "amazon"],
    "earliness": ["late", "peak", "piek", "hype", "fad", "seasonal", "seizoen", "trend", "early", "vroeg",
                  "dood", "dying"],
    "demand": ["demand", "vraag", "volume", "searches", "zoek", "niche", "small", "klein"],
    "match": ["match", "wrong", "verkeerd", "different", "anders", "same", "quality", "kwaliteit",
              "photo", "foto", "supplier", "leverancier"],
}


def features(opp: dict[str, Any]) -> list[str]:
    f = []
    if opp.get("category"):
        f.append(f"cat:{opp['category']}")
    if opp.get("category2"):
        f.append(f"cat2:{opp['category2']}")
    for t in sorted(content_tokens(opp.get("keyword") or ""))[:4]:
        f.append(f"kw:{t}")
    price = opp.get("sale_price") or 0
    f.append("price:" + ("<10" if price < 10 else "10-20" if price < 20 else "20-35" if price < 35 else "35+"))
    profit = opp.get("profit_eur") or 0
    f.append("profit:" + ("<3" if profit < 3 else "3-6" if profit < 6 else "6-10" if profit < 10 else "10+"))
    if opp.get("size"):
        f.append(f"size:{opp['size']}")
    f.append(f"printable:{'yes' if opp.get('printable') else 'no'}")
    if opp.get("competition_level"):
        f.append(f"comp:{opp['competition_level']}")
    if opp.get("stage"):
        f.append(f"stage:{opp['stage']}")
    return f


class Learner:
    def __init__(self, conn: sqlite3.Connection, settings: dict[str, Any]):
        self.strength = max(0.0, min(1.0, float(settings.get("learning_strength", 0.5))))
        self.counts: dict[str, list[float]] = defaultdict(lambda: [0.0, 0.0])  # feature -> [approved, rejected]
        self.n_decisions = 0
        mentions = {p: 0 for p in PARTS}
        for row in conn.execute("SELECT decision, reason, features_json FROM decisions ORDER BY id"):
            self.n_decisions += 1
            idx = 0 if row["decision"] == "approved" else 1
            for feat in loads(row["features_json"], []):
                self.counts[feat][idx] += 1
            reason = (row["reason"] or "").lower()
            for part, words in REASON_WORDS.items():
                if any(w in reason for w in words):
                    mentions[part] += 1
        self.multipliers = {p: round(max(0.6, min(1.6, 1 + 0.1 * mentions[p])), 2) for p in PARTS}
        self.mentions = mentions

    @property
    def active(self) -> bool:
        return self.n_decisions >= 3 and self.strength > 0

    def adjustment(self, feats: list[str]) -> tuple[float, str]:
        """Return (points to add, plain-language note)."""
        if not self.active:
            return 0.0, ""
        prefs = []
        for feat in feats:
            a, r = self.counts.get(feat, (0.0, 0.0))
            if a + r == 0:
                continue
            prefs.append((math.log((a + 1) / (r + 1)), feat, a, r))
        if not prefs:
            return 0.0, ""
        mean = sum(p for p, *_ in prefs) / len(prefs)
        points = round(15 * self.strength * math.tanh(mean), 1)
        strongest = max(prefs, key=lambda x: abs(x[0]))
        _p, feat, a, r = strongest
        label = feat.split(":", 1)[1]
        kind = {"cat": "category", "cat2": "category", "kw": "keyword word", "price": "price band",
                "profit": "profit band", "size": "size", "printable": "printable",
                "comp": "competition level", "stage": "trend stage"}.get(feat.split(":")[0], "feature")
        if abs(points) < 0.5:
            return 0.0, ""
        direction = "up" if points > 0 else "down"
        note = (f"Ranked {direction} {abs(points):.0f} pts from your decisions "
                f"({kind} '{label}': {int(a)} approved, {int(r)} rejected).")
        return points, note

    def summary(self) -> dict[str, Any]:
        top = sorted(
            ((math.log((a + 1) / (r + 1)), f, a, r) for f, (a, r) in self.counts.items() if a + r >= 2),
            key=lambda x: -abs(x[0]),
        )[:10]
        return {
            "decisions": self.n_decisions,
            "active": self.active,
            "multipliers": self.multipliers,
            "preferences": [{"feature": f, "approved": int(a), "rejected": int(r), "preference": round(p, 2)}
                            for p, f, a, r in top],
        }
