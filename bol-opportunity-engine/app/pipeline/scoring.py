"""Step 7 - Score: one number 0-100 from five parts, each 0-1:
demand growth, earliness, competition weakness, profit and match confidence.
Weights come from Settings and are nudged by what you approve/reject
(see learning.py). Every score gets a plain-language explanation.
"""
from __future__ import annotations

import math
from statistics import median
from typing import Any

PARTS = ("demand", "earliness", "competition", "profit", "match")


def _sat(x: float | None, full: float) -> float:
    if x is None:
        return 0.0
    return max(0.0, min(1.0, x / full))


def demand_part(sig: dict[str, Any]) -> float:
    vol = sig.get("avg_weekly") or 0
    yoy = sig.get("yoy")
    yoy_part = _sat(yoy, 2.0) if yoy is not None else 0.4 * _sat(sig.get("growth_4w"), 1.0)
    return round(0.40 * yoy_part + 0.35 * _sat(sig.get("excess_growth") if sig.get("excess_growth") is not None
                                                 else sig.get("growth_4w"), 0.8)
                 + 0.25 * _sat(math.log10(max(vol, 1)) - 2, 1.5), 3)


def competition_summary(competitors: list[dict[str, Any]]) -> dict[str, Any]:
    offers = [c["offers"] for c in competitors if c.get("offers") is not None]
    reviews = [c["reviews"] or 0 for c in competitors]
    weak_listings = sum(1 for c in competitors if c.get("weak_listing"))
    med_offers = median(offers) if offers else 0
    top3_reviews = sum(sorted(reviews, reverse=True)[:3])
    w_offers = 1 - min(1.0, max(0.0, med_offers - 1) / 10)
    w_reviews = 1 - min(1.0, math.log1p(top3_reviews) / math.log1p(800))
    w_listing = weak_listings / len(competitors) if competitors else 0.5
    score = 0.45 * w_offers + 0.40 * w_reviews + 0.15 * w_listing
    level = "weak" if score >= 0.65 else ("medium" if score >= 0.4 else "strong")
    return {"median_offers": med_offers, "top3_reviews": top3_reviews, "weak_listings": weak_listings,
            "products": len(competitors), "score": round(score, 3), "level": level}


def profit_part(profit: dict[str, Any]) -> float:
    return round(0.6 * _sat(profit["profit"], 12.0) + 0.4 * _sat(profit["margin"], 0.5), 3)


def combine(parts: dict[str, float], settings: dict[str, Any], multipliers: dict[str, float] | None = None) -> float:
    multipliers = multipliers or {}
    weights = {p: float(settings[f"weight_{p}"]) * multipliers.get(p, 1.0) for p in PARTS}
    total_w = sum(weights.values()) or 1.0
    return round(100 * sum(weights[p] * parts[p] for p in PARTS) / total_w, 1)


def _pct(x: float | None) -> str:
    return "n/a" if x is None else f"{x:+.0%}"


def explain(keyword: str, sig: dict[str, Any], comp: dict[str, Any], profit: dict[str, Any],
            match: dict[str, Any], printable: dict[str, Any], learning_note: str = "",
            also: list[str] | None = None) -> str:
    """Template explanation in plain words (used when no AI, and as AI input)."""
    s = []
    if sig.get("yoy") is not None:
        seasonal = ""
        if (sig.get("ly_growth") or 0) > 0.15:
            seasonal = (f" Last year these weeks also grew ({_pct(sig['ly_growth'])}), but this year grows much "
                        "faster, so it is more than a seasonal bump.")
        s.append(f"Searches for '{keyword}' on bol rose {_pct(sig['growth_4w'])} in the last 4 weeks "
                 f"(~{sig['avg_weekly']:.0f}/week) and are {_pct(sig['yoy'])} versus the same weeks last year."
                 + seasonal)
    else:
        s.append(f"Searches for '{keyword}' rose {_pct(sig['growth_4w'])} in the last 4 weeks "
                 f"(~{sig['avg_weekly']:.0f}/week); there is no last-year data yet.")
    if also:
        s.append("Also searched as: " + ", ".join(f"'{a}'" for a in also[:4]) + ".")
    stage = sig.get("stage")
    if stage == "early":
        s.append(f"It looks early: the rise started about {max(1, sig['weeks_rising'])} weeks ago"
                 + (" and is still accelerating." if sig.get("accelerating") else "."))
    elif stage == "growing":
        s.append(f"It is growing but not brand new (rising for ~{sig['weeks_rising']} weeks"
                 + (", growth is slowing)." if not sig.get("accelerating") else ")."))
    else:
        s.append("It may be late: growth is slowing or close to its peak.")
    s.append(f"Competition is {comp['level']}: the top {comp['products']} products have a median of "
             f"{comp['median_offers']:g} seller(s) and {comp['top3_reviews']} reviews in the top 3"
             + (f"; {comp['weak_listings']} have weak listings." if comp['weak_listings'] else "."))
    s.append(f"Selling at EUR {profit['sale_price']:.2f} you keep about EUR {profit['profit']:.2f} per unit "
             f"({profit['margin']:.0%} margin, landed cost EUR {profit['landed_cost']:.2f}).")
    s.append(f"AliExpress match confidence {match['confidence']:.0%}.")
    if printable.get("printable"):
        s.append(f"You could print this yourself for ~EUR {printable['print_cost']:.2f} per unit.")
    if learning_note:
        s.append(learning_note)
    return " ".join(s)


AI_SYSTEM = (
    "You write short, plain-language explanations for a Dutch bol.com seller. Rewrite the facts into 2-4 "
    "simple English sentences: why this product is (or is not) a good opportunity right now. Keep every "
    "number exactly as given. No hype, no marketing words. Answer ONLY with JSON: {\"text\": \"...\"}."
)


def ai_explain(ai, facts: str) -> str | None:
    if ai is None or not ai.available:
        return None
    out = ai.complete_json("explain", AI_SYSTEM, facts, max_tokens=300)
    if isinstance(out, dict) and isinstance(out.get("text"), str) and len(out["text"]) > 20:
        return out["text"].strip()
    return None
