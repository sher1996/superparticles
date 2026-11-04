"""Step 1 - Seeds: turn AliExpress hot-product titles into Dutch bol search
terms (AI, or the rule-based dictionary as fallback). bol's related search
terms are added in the demand step, so the keyword list keeps growing."""
from __future__ import annotations

from typing import Any

from .text import extract_keywords_rule_based, translate_nl_to_en

AI_SEED_SYSTEM = (
    "You help a Dutch bol.com seller. For each numbered AliExpress product title, give the short Dutch "
    "search terms (1-3 words) a Dutch shopper would type into bol.com to find that product, and a short "
    "English product phrase (2-4 words) for searching AliExpress. Skip titles that are not a clear product. "
    "Answer ONLY with JSON: [{\"i\": <number>, \"nl\": [\"term\", ...], \"en\": \"phrase\"}]."
)

AI_TRANSLATE_SYSTEM = (
    "Translate a Dutch bol.com search term into a short English product phrase (2-4 words) that works as "
    "an AliExpress search. Answer ONLY with JSON: {\"en\": \"...\"}."
)


def keywords_from_titles(titles: list[str], ai=None) -> list[dict[str, Any]]:
    """Return [{"nl": term, "en": phrase, "title": source title, "via": "ai"|"rules"}]."""
    out: list[dict[str, Any]] = []
    done: set[int] = set()
    if ai is not None and ai.available:
        for start in range(0, len(titles), 25):
            chunk = titles[start:start + 25]
            text = "\n".join(f"{start + n + 1}. {t}" for n, t in enumerate(chunk))
            res = ai.complete_json("seeds", AI_SEED_SYSTEM, text, max_tokens=1500)
            if not isinstance(res, list):
                continue
            for item in res:
                try:
                    i = int(item["i"]) - 1
                    title = titles[i]
                except (KeyError, ValueError, TypeError, IndexError):
                    continue
                en = str(item.get("en") or "").strip().lower()
                for term in (item.get("nl") or [])[:3]:
                    term = str(term).strip().lower()
                    if 2 < len(term) <= 60:
                        out.append({"nl": term, "en": en, "title": title, "via": "ai"})
                        done.add(i)
    for i, title in enumerate(titles):
        if i in done:
            continue
        for kw in extract_keywords_rule_based(title):
            out.append({"nl": kw["nl"], "en": kw["en"], "title": title, "via": "rules"})
    seen: set[str] = set()
    unique = []
    for kw in out:
        if kw["nl"] not in seen:
            seen.add(kw["nl"])
            unique.append(kw)
    return unique


def english_for(term: str, stored: str | None, ai=None) -> str:
    if stored:
        return stored
    if ai is not None and ai.available:
        res = ai.complete_json("translate", AI_TRANSLATE_SYSTEM, term, max_tokens=60)
        if isinstance(res, dict) and res.get("en"):
            return str(res["en"]).strip().lower()
    return translate_nl_to_en(term)
