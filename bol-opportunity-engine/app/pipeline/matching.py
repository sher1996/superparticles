"""Step 4 - Supply match: find the AliExpress product that is the same as the
products selling on bol. There is no shared ID, so we compare title, specs,
price and (optionally) photos, and give every match a confidence score 0-1.

Rule-based (always available): keyword phrase in the title, word overlap
after translating the bol title to English, size/quantity agreement, price
sanity and - in live mode, when Pillow is installed - a photo similarity hash.
AI (when a key is set): Claude compares titles and photos and returns the best
candidate with a confidence; we blend it with the rule score.
"""
from __future__ import annotations

import io
from typing import Any, Callable

import requests

from .text import compare_specs, content_tokens, parse_specs, translate_nl_to_en

try:
    from PIL import Image
except ImportError:  # optional
    Image = None  # type: ignore


def rule_score(english_phrase: str, bol_ref: dict[str, Any], cand: dict[str, Any],
               image_sim: float | None = None) -> tuple[float, list[str]]:
    reasons: list[str] = []
    a_title = cand.get("title") or ""
    a_tokens = content_tokens(a_title)
    phrase_tokens = content_tokens(english_phrase)
    score = 0.0
    if phrase_tokens and phrase_tokens <= a_tokens:
        score += 0.40
        reasons.append(f"title contains '{english_phrase}'")
    elif phrase_tokens:
        part = len(phrase_tokens & a_tokens) / len(phrase_tokens)
        score += 0.40 * part * 0.6
        if part:
            reasons.append("title partly matches the keyword")

    bol_en = translate_nl_to_en(bol_ref.get("title") or "")
    b_tokens = content_tokens(bol_en)
    if b_tokens and a_tokens:
        overlap = len(b_tokens & a_tokens) / max(1, min(len(b_tokens), len(a_tokens)))
        score += 0.25 * min(1.0, overlap)
        shared = sorted(b_tokens & a_tokens)
        if shared:
            reasons.append("shared words: " + ", ".join(shared[:5]))

    spec_score, spec_notes = compare_specs(parse_specs(bol_ref.get("title") or ""), parse_specs(a_title))
    score += 0.15 * spec_score
    reasons += spec_notes

    bol_price, ali_price = bol_ref.get("price"), cand.get("price")
    if bol_price and ali_price:
        ratio = ali_price / bol_price
        if ratio <= 0.6:
            score += 0.10
        elif ratio > 1.0:
            score -= 0.20
            reasons.append("AliExpress price is higher than bol price")

    if cand.get("volume", 0) >= 500:
        score += 0.05
    if image_sim is not None:
        score += 0.15 * (image_sim - 0.5) * 2
        reasons.append(f"photo similarity {image_sim:.0%}")
    return max(0.0, min(1.0, score)), reasons


def _ahash(url: str) -> int | None:
    if Image is None or not url.startswith("http"):
        return None
    try:
        r = requests.get(url, timeout=10)
        if r.status_code != 200:
            return None
        img = Image.open(io.BytesIO(r.content)).convert("L").resize((8, 8))
        px = list(img.getdata())
        avg = sum(px) / len(px)
        return sum(1 << i for i, p in enumerate(px) if p >= avg)
    except Exception:  # noqa: BLE001 - photo comparison is optional
        return None


def image_similarity(url_a: str, url_b: str) -> float | None:
    ha, hb = _ahash(url_a), _ahash(url_b)
    if ha is None or hb is None:
        return None
    return 1 - bin(ha ^ hb).count("1") / 64


AI_SYSTEM = (
    "You match products between bol.com (Dutch marketplace) and AliExpress. Decide which AliExpress "
    "candidate is the SAME product (same type, shape, size, material, quantity) as the bol reference. "
    "Answer ONLY with JSON: {\"best\": <candidate number or null>, \"confidence\": <0..1>, "
    "\"reason\": \"<one short sentence>\"}. Use null when none is the same product."
)


def best_match(english_phrase: str, bol_ref: dict[str, Any], candidates: list[dict[str, Any]],
               ai=None, use_images: bool = False, compare_photos: bool = False,
               log: Callable[[str, str], None] | None = None) -> dict[str, Any] | None:
    if not candidates:
        return None
    scored = []
    for c in candidates:
        sim = image_similarity(bol_ref.get("image_url") or "", c.get("image_url") or "") if compare_photos else None
        s, reasons = rule_score(english_phrase, bol_ref, c, sim)
        scored.append((s, c, reasons))
    scored.sort(key=lambda x: (-x[0], -(x[1].get("volume") or 0)))
    top = scored[:6]
    best_s, best_c, best_r = top[0]
    result = {"product": best_c, "confidence": round(best_s, 3),
              "reason": "; ".join(best_r) or "weak title match", "source": "rules"}

    if ai is not None and ai.available:
        lines = [f"bol reference: {bol_ref.get('title')} | price EUR {bol_ref.get('price')}"]
        for n, (_s, c, _r) in enumerate(top, 1):
            lines.append(f"{n}. {c.get('title')} | price EUR {c.get('price')}")
        images = []
        if use_images:
            images = [bol_ref.get("image_url") or ""] + [c.get("image_url") or "" for _s, c, _r in top]
            if all(u.startswith("http") for u in images):
                lines.append("Images: first = bol reference, then candidates 1..n in order.")
            else:
                images = []
        out = ai.complete_json("match", AI_SYSTEM, "\n".join(lines), images=images, max_tokens=200)
        if isinstance(out, dict) and "confidence" in out:
            try:
                ai_conf = max(0.0, min(1.0, float(out.get("confidence") or 0)))
                idx = out.get("best")
                if idx is None:
                    result.update(confidence=round(min(best_s, ai_conf) * 0.5, 3),
                                  reason=f"AI: no candidate is the same product. {out.get('reason', '')}".strip(),
                                  source="ai")
                else:
                    s_rule, c, _r = top[int(idx) - 1]
                    result = {"product": c, "confidence": round(0.7 * ai_conf + 0.3 * s_rule, 3),
                              "reason": f"AI: {out.get('reason', '')}".strip(), "source": "ai"}
            except (ValueError, IndexError, TypeError):
                if log:
                    log("warning", "AI match answer was not usable; kept the rule-based match.")
    return result
