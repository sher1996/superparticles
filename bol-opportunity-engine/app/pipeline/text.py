"""Text helpers: tokenising, a small English<->Dutch product dictionary (used
when no AI key is set), keyword extraction from AliExpress titles, and
spec parsing (sizes, counts) for matching."""
from __future__ import annotations

import re
import unicodedata

# English phrase -> (Dutch, kind). kind: "noun" = what the product IS,
# "mod" = a describing word that can precede it. Longest phrases match first.
# Extend freely; the AI path does not need this list.
EN_NL: dict[str, tuple[str, str]] = {
    # nouns (products)
    "spice rack": ("kruidenrek", "noun"),
    "wall sticker": ("muursticker", "noun"),
    "wall stickers": ("muursticker", "noun"),
    "wall decal": ("muursticker", "noun"),
    "cable organizer": ("kabel organizer", "noun"),
    "cable management": ("kabel organizer", "noun"),
    "air fryer liner": ("airfryer bakjes", "noun"),
    "window film": ("raamfolie", "noun"),
    "hanging planter": ("hangende plantenbak", "noun"),
    "plant hanger": ("plantenhanger", "noun"),
    "door stopper": ("deurstopper", "noun"),
    "laptop stand": ("laptopstandaard", "noun"),
    "window stickers": ("raamstickers", "noun"),
    "window sticker": ("raamstickers", "noun"),
    "night light": ("nachtlampje", "noun"),
    "play tent": ("speeltent", "noun"),
    "face serum": ("gezichtsserum", "noun"),
    "matcha powder": ("matcha poeder", "noun"),
    "phone case": ("telefoonhoesje", "noun"),
    "hoodie": ("hoodie", "noun"),
    "wall mirror": ("wandspiegel", "noun"),
    "shoe rack": ("schoenenrek", "noun"),
    "poster": ("poster", "noun"),
    "key holder": ("sleutelrek", "noun"),
    "car sticker": ("autosticker", "noun"),
    "desk organizer": ("bureau organizer", "noun"),
    "shower caddy": ("douchemandje", "noun"),
    "name labels": ("naamstickers", "noun"),
    "pet hair remover": ("huisdierhaar roller", "noun"),
    "lint roller": ("pluizenroller", "noun"),
    "bean bag": ("zitzak", "noun"),
    "lunch box": ("lunchbox", "noun"),
    "yoga mat": ("yogamat", "noun"),
    "storage box": ("opbergbox", "noun"),
    "pen holder": ("pennenhouder", "noun"),
    "candle holder": ("kandelaar", "noun"),
    "photo frame": ("fotolijst", "noun"),
    "doormat": ("deurmat", "noun"),
    "banner": ("spandoek", "noun"),
    "sticker": ("sticker", "noun"),
    "stickers": ("stickers", "noun"),
    "decal": ("sticker", "noun"),
    # modifiers
    "magnetic": ("magnetisch", "mod"),
    "moon phase": ("maanfasen", "mod"),
    "silicone": ("siliconen", "mod"),
    "privacy": ("privacy", "mod"),
    "macrame": ("macramé", "mod"),
    "christmas": ("kerst", "mod"),
    "kids": ("kinder", "mod"),
    "oversized": ("oversized", "mod"),
    "round": ("ronde", "mod"),
    "abstract": ("abstracte", "mod"),
    "rotating": ("draaibare", "mod"),
    "giant": ("grote", "mod"),
    "bento": ("bento", "mod"),
    "foldable": ("opvouwbaar", "mod"),
    "wooden": ("houten", "mod"),
    "funny": ("grappige", "mod"),
    "custom": ("persoonlijke", "mod"),
    "boho": ("boho", "mod"),
}

# Dutch word/phrase -> English (for translating bol titles when matching).
NL_EN: dict[str, str] = {nl: en for en, (nl, _k) in EN_NL.items()}
NL_EN.update({
    "magnetisch": "magnetic", "magnetische": "magnetic", "koelkast": "fridge", "keuken": "kitchen",
    "opbergrek": "storage rack", "opbergen": "storage", "zwart": "black", "wit": "white",
    "metaal": "metal", "metalen": "metal", "hout": "wood", "houten": "wooden", "siliconen": "silicone",
    "herbruikbaar": "reusable", "herbruikbare": "reusable", "badkamer": "bathroom",
    "zonder boren": "no drilling", "zelfklevend": "self adhesive", "waterdicht": "waterproof",
    "stuks": "pcs", "slaapkamer": "bedroom", "woonkamer": "living room", "decoratie": "decoration",
    "plantenbak": "planter", "hangende": "hanging", "hangend": "hanging", "binnen": "indoor",
    "bureau": "desk", "draaibaar": "rotating", "draaibare": "rotating", "haken": "hooks",
    "sleutels": "keys", "matglas": "frosted", "statisch": "static", "maan": "moon",
    "abstracte": "abstract", "kabel": "cable", "kabels": "cable", "kabelgoot": "cable tray",
    "onder": "under", "huisdier": "pet", "huisdieren": "pet", "huisdierhaar": "pet hair",
    "pluizen": "lint", "borstel": "brush", "meubels": "furniture", "school": "school",
    "airfryer": "air fryer", "bakjes": "liner", "bakje": "liner", "mand": "basket",
    "lagen": "tier", "laags": "tier", "planken": "shelf", "plank": "shelf", "rek": "rack",
    "muur": "wall", "wand": "wall", "raam": "window", "glas": "glass", "kerst": "christmas",
    "sneeuwvlok": "snowflake", "goud": "gold", "rond": "round", "ronde": "round",
    "verstelbaar": "adjustable", "verstelbare": "adjustable", "aluminium": "aluminum",
    "opvouwbaar": "foldable", "inklapbaar": "foldable", "kinderen": "kids", "kinder": "kids",
    "speelgoed": "toy", "grappige": "funny", "auto": "car", "naam": "name", "labels": "labels",
    "persoonlijke": "custom", "gepersonaliseerde": "custom", "vinyl": "vinyl", "boho": "boho",
    "macramé": "macrame", "plantenhanger": "plant hanger", "set": "set", "privacy": "privacy",
    "vloeibaar": "liquid", "katoen": "cotton", "lamp": "lamp", "bewegingssensor": "motion sensor",
    "oplaadbaar": "rechargeable", "pennenhouder": "pen holder", "opbergbox": "storage box",
    "douche": "shower", "planten": "plant", "deur": "door",
})

NOISE = {
    "new", "hot", "sale", "2023", "2024", "2025", "2026", "2027", "free", "shipping", "best",
    "top", "quality", "high", "fashion", "style", "pcs", "pc", "piece", "pieces", "set", "for",
    "with", "and", "the", "a", "of", "in", "to", "on", "home", "accessories", "tool", "tools",
    "gift", "gifts", "creative", "portable", "multifunctional", "universal", "durable", "premium",
    "upgraded", "upgrade", "original", "cheap", "wholesale", "dropshipping", "1pc", "2pcs",
}

STOP_NL = {"de", "het", "een", "en", "voor", "met", "van", "in", "op", "-", "|", "/", "&"}


def normalize(text: str) -> str:
    text = unicodedata.normalize("NFKD", text or "")
    text = "".join(c for c in text if not unicodedata.combining(c))
    text = text.lower().replace("&", " ").replace("/", " ")
    text = re.sub(r"[^\w\s.x-]", " ", text)
    return re.sub(r"\s+", " ", text).strip()


def tokens(text: str) -> list[str]:
    return [t for t in re.split(r"[\s\-_,.;:()]+", normalize(text)) if t]


def _phrase_index() -> list[tuple[list[str], str, str, str]]:
    out = []
    for en, (nl, kind) in EN_NL.items():
        out.append((tokens(en), en, nl, kind))
    out.sort(key=lambda x: -len(x[0]))
    return out


_PHRASES = _phrase_index()


def find_phrases(title: str) -> list[tuple[int, int, str, str, str]]:
    """Return non-overlapping (start, end, en, nl, kind) dictionary hits in title order."""
    toks = tokens(title)
    taken = [False] * len(toks)
    hits = []
    for ptoks, en, nl, kind in _PHRASES:
        n = len(ptoks)
        for i in range(len(toks) - n + 1):
            if toks[i:i + n] == ptoks and not any(taken[i:i + n]):
                hits.append((i, i + n, en, nl, kind))
                for j in range(i, i + n):
                    taken[j] = True
    hits.sort()
    return hits


NOUN_PRIORITY = {"poster": 2, "window film": 2, "spice rack": 2}


def extract_keywords_rule_based(title: str) -> list[dict[str, str]]:
    """Turn a spammy AliExpress title into 1-2 Dutch search terms (fallback when no AI).

    "Magnetic Spice Rack Fridge Organizer" -> kruidenrek, magnetisch kruidenrek.
    Returns [] when no product noun is recognised (we never guess)."""
    hits = find_phrases(title)
    nouns = [h for h in hits if h[4] == "noun"]
    if not nouns:
        return []
    # the main product noun: highest priority, then the first in the title
    best = max(nouns, key=lambda h: (NOUN_PRIORITY.get(h[2], 1), -h[0]))
    out = [{"nl": best[3], "en": best[2]}]
    mods = [h for h in hits if h[4] == "mod" and h[1] == best[0]]
    if mods:
        m = mods[0]
        out.insert(0, {"nl": f"{m[3]} {best[3]}", "en": f"{m[2]} {best[2]}"})
    return out


def translate_nl_to_en(text: str) -> str:
    """Word-by-word Dutch -> English using the dictionary (unknown words are kept)."""
    toks = tokens(text)
    out: list[str] = []
    i = 0
    nl_phrases = sorted(((tokens(k), v) for k, v in NL_EN.items()), key=lambda x: -len(x[0]))
    while i < len(toks):
        for ptoks, en in nl_phrases:
            n = len(ptoks)
            if n and toks[i:i + n] == ptoks:
                out.append(en)
                i += n
                break
        else:
            if toks[i] not in STOP_NL:
                out.append(toks[i])
            i += 1
    return " ".join(out)


def content_tokens(text: str) -> set[str]:
    return {t for t in tokens(text) if t not in NOISE and t not in STOP_NL and len(t) > 1
            and not re.fullmatch(r"\d+([x.]\d+)*(cm|mm|ml|m|g|kg|pcs)?", t)}


# --- specs ------------------------------------------------------------------
DIM_RE = re.compile(r"(\d+(?:[.,]\d+)?)\s*[x×*]\s*(\d+(?:[.,]\d+)?)(?:\s*[x×*]\s*(\d+(?:[.,]\d+)?))?\s*(cm|mm|m)\b", re.I)
SIZE_RE = re.compile(r"(?<![x×*\d])(\d+(?:[.,]\d+)?)\s*(cm|mm|ml|l|kg|g)\b", re.I)
COUNT_RE = re.compile(r"(\d+)\s*(?:pcs|pieces|stuks|st\b|pack|delig|sheets|vellen|tier|lagen|laags|hooks|haken)", re.I)


def _num(s: str) -> float:
    return float(s.replace(",", "."))


def parse_specs(text: str) -> dict[str, object]:
    text = text or ""
    specs: dict[str, object] = {}
    m = DIM_RE.search(text)
    if m:
        unit = m.group(4).lower()
        f = {"cm": 1.0, "mm": 0.1, "m": 100.0}[unit]
        dims = [round(_num(g) * f, 1) for g in m.groups()[:3] if g]
        specs["dims_cm"] = dims
    sizes = []
    for val, unit in SIZE_RE.findall(DIM_RE.sub(" ", text)):
        sizes.append((round(_num(val), 1), unit.lower()))
    if sizes:
        specs["sizes"] = sizes
    counts = [int(c) for c in COUNT_RE.findall(text)]
    if counts:
        specs["counts"] = counts
    return specs


def compare_specs(a: dict, b: dict) -> tuple[float, list[str]]:
    """+1 = specs agree, -1 = specs conflict, 0 = nothing to compare."""
    score = 0.0
    notes = []
    if a.get("dims_cm") and b.get("dims_cm"):
        da, db_ = sorted(a["dims_cm"]), sorted(b["dims_cm"])
        if len(da) == len(db_) and all(abs(x - y) <= max(2.0, 0.08 * max(x, y)) for x, y in zip(da, db_)):
            score += 1
            notes.append("same size")
        else:
            score -= 1
            notes.append("different size")
    sa = {u: v for v, u in a.get("sizes", [])}
    sb = {u: v for v, u in b.get("sizes", [])}
    for unit in set(sa) & set(sb):
        if abs(sa[unit] - sb[unit]) <= max(1.0, 0.1 * max(sa[unit], sb[unit])):
            score += 0.5
            notes.append(f"same {unit}")
        else:
            score -= 0.5
            notes.append(f"different {unit}")
    if a.get("counts") and b.get("counts"):
        if set(a["counts"]) & set(b["counts"]):
            score += 0.5
            notes.append("same quantity")
    return max(-1.0, min(1.0, score)), notes
