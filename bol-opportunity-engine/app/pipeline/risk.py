"""Step 6 - Risk filter. Drops products that are risky to import and resell:
electronics/batteries, kids' toys, cosmetics, food, items needing CE or other
certification, clothing/shoes with sizes, fragile or heavy/large items, and
anything with brand names or trademarks. Matching is on Dutch AND English words
in the bol titles, AliExpress title and category. An optional AI check adds a
second opinion for brands/certification (never removes a rule-based flag).
"""
from __future__ import annotations

import re
from typing import Any

from .text import normalize, parse_specs

HARD_RULES: dict[str, tuple[str, list[str]]] = {
    "electronics": ("Electronics / batteries (CE, WEEE, battery rules)", [
        "led", "usb", "battery", "batteries", "batterij", "batterijen", "accu", "rechargeable", "oplaadbaar",
        "oplaadbare", "bluetooth", "wireless", "draadloos", "draadloze", "electric", "elektrisch", "elektrische",
        "charger", "oplader", "adapter", "power bank", "powerbank", "solar", "zonne-energie", "motion sensor",
        "bewegingssensor", "remote control", "afstandsbediening", "lamp", "lampje", "light bulb", "speaker",
        "headphones", "koptelefoon", "earbuds", "smart", "wifi", "camera", "lithium", "volt", "220v", "12v",
        "heating", "verwarming", "vibration", "vibrator", "fan", "ventilator", "humidifier", "luchtbevochtiger",
        "nachtlampje", "lights & lighting", "consumer electronics", "cellphones telecommunications",
    ]),
    "kids_toys": ("Kids' toys / baby products (EN71 safety, CE)", [
        "toy", "toys", "speelgoed", "plush", "knuffel", "doll", "teether", "bijtring", "baby", "babies",
        "infant", "pacifier", "speen", "fidget", "squishy", "play tent", "speeltent", "toys hobbies",
        "mother kids", "montessori", "rattle", "rammelaar",
    ]),
    "cosmetics": ("Cosmetics / skin care (EU Cosmetics Regulation)", [
        "cosmetic", "cosmetics", "cosmetica", "serum", "cream", "creme", "makeup", "make-up", "lipstick",
        "mascara", "nail polish", "nagellak", "shampoo", "perfume", "parfum", "skin care", "huidverzorging",
        "whitening", "lotion", "beauty health", "eyelash", "wimpers", "hair dye", "haarverf", "tattoo ink",
    ]),
    "food": ("Food / supplements (NVWA food rules)", [
        "food", "voedsel", "snack", "snacks", "tea", "thee", "coffee", "koffie", "matcha", "supplement",
        "supplements", "vitamin", "vitamine", "capsules", "protein", "eiwit", "candy", "snoep", "chocolate",
        "chocolade", "spice mix", "kruidenmix", "herbal", "edible", "eetbaar",
    ]),
    "certification": ("Needs certification (PPE, medical, safety)", [
        "helmet", "helm", "ppe", "medical", "medisch", "medische", "face mask", "mondkapje", "respirator",
        "first aid", "ehbo", "car seat", "autostoel", "fire extinguisher", "brandblusser", "smoke detector",
        "rookmelder", "life jacket", "reddingsvest", "thermometer", "blood pressure", "bloeddruk",
        "contact lens", "lenzen", "pesticide", "insecticide", "gas", "pressure cooker", "snelkookpan",
        "laser", "drone", "weapon", "wapen", "knife", "mes", "pepper spray",
    ]),
    "clothing_sizes": ("Clothing / shoes with sizes (returns, size charts)", [
        "t-shirt", "shirt", "dress", "jurk", "hoodie", "sweater", "trui", "jacket", "jas", "pants", "broek",
        "jeans", "leggings", "shoes", "schoenen", "sneakers", "boots", "laarzen", "sandals", "slippers",
        "bra", "bh", "lingerie", "underwear", "ondergoed", "swimsuit", "badpak", "bikini", "size s",
        "maat", "sizes", "women's clothing", "men's clothing", "shoe size", "eu 38", "pullover", "vest",
    ]),
    "fragile": ("Fragile (breaks in transit, high return rate)", [
        "glass", "glas", "glazen", "ceramic", "keramiek", "keramische", "porcelain", "porselein", "mirror",
        "spiegel", "wandspiegel", "crystal", "kristal", "marble", "marmer", "vase", "vaas",
    ]),
    "large_heavy": ("Heavy / large (expensive shipping, storage)", [
        "furniture", "meubel", "sofa", "bank", "chair", "stoel", "table", "tafel", "cabinet", "kast",
        "mattress", "matras", "bean bag", "zitzak", "bed frame", "bedframe", "wardrobe", "bicycle", "fiets",
        "treadmill", "loopband", "dumbbell", "halter", "kettlebell", "living room furniture",
    ]),
}

# phrases that contain a risky word but are fine (checked before matching)
WHITELIST = [
    "shoe rack", "schoenenrek", "shoe organizer", "schoenenkast", "glass sticker", "glass film",
    "for glass", "voor glas", "op glas", "window film", "raamfolie", "spice rack", "kruidenrek",
    "desk organizer", "bureau organizer", "laptop stand", "laptopstandaard", "fridge", "koelkast",
    "pen holder", "kitchen storage", "kids room", "kinderkamer", "naamstickers kinderen",
    "lint roller", "pet hair", "storage box", "air fryer", "airfryer", "for furniture",
    "voor meubels",
]

BRANDS = [
    "apple", "iphone", "ipad", "airpods", "macbook", "samsung", "huawei", "xiaomi", "sony",
    "playstation", "nintendo", "xbox", "microsoft", "google pixel", "nike", "adidas", "puma",
    "reebok", "new balance", "converse", "vans", "gucci", "louis vuitton", "chanel", "prada", "rolex",
    "casio", "disney", "marvel", "pixar", "star wars", "harry potter", "pokemon", "pokémon", "hello kitty",
    "barbie", "lego", "hot wheels", "minecraft", "fortnite", "paw patrol", "peppa pig", "stanley cup",
    "yeti", "dyson", "philips", "bosch", "ikea", "tefal", "nespresso", "dolce gusto", "tesla", "bmw",
    "mercedes", "audi", "volkswagen", "ferrari", "porsche", "ajax", "psv", "feyenoord", "barcelona",
    "real madrid", "manchester", "fifa", "nba", "nfl", "tiktok", "instagram", "labubu", "sanrio",
    "squishmallow", "mickey", "minnie", "spiderman", "batman", "superman",
]
TRADEMARK_PATTERNS = [r"™", r"®", r"\bcompatible with\b", r"\bgeschikt voor (?:apple|samsung|iphone)\b",
                      r"\breplica\b", r"\binspired by\b"]

SOFT_NOTES: dict[str, tuple[str, list[str]]] = {
    "food_contact": ("Food-contact item: ask the supplier for an EU food-safety (LFGB / EU 10/2011) declaration.", [
        "air fryer", "airfryer", "lunch box", "lunchbox", "bento", "baking", "bakvorm",
        "silicone mold", "drinking", "cup", "beker", "bottle", "fles", "liner",
    ]),
    "adhesive": ("Adhesive product: check reviews for 'falls off' complaints before ordering stock.", [
        "adhesive", "zelfklevend", "self adhesive", "no drilling", "zonder boren",
    ]),
    "personalised": ("Personalised item: needs a workflow to collect names/text from buyers.", [
        "custom", "personalised", "personalized", "gepersonaliseerde", "name labels", "naamstickers",
    ]),
}


def _compile(words: list[str]) -> re.Pattern:
    parts = sorted({re.escape(normalize(w)) for w in words if w}, key=len, reverse=True)
    return re.compile(r"(?<![\w])(" + "|".join(parts) + r")(?![\w])")


_HARD = {code: (label, _compile(words)) for code, (label, words) in HARD_RULES.items()}
_SOFT = {code: (label, _compile(words)) for code, (label, words) in SOFT_NOTES.items()}
_WHITELIST = _compile(WHITELIST)


def check(texts: list[str], settings: dict[str, Any], ai_flags: list[dict] | None = None) -> dict[str, Any]:
    raw = " | ".join(t for t in texts if t)
    text = _WHITELIST.sub(" ", normalize(raw))
    flags: list[dict[str, str]] = []
    for code, (label, pattern) in _HARD.items():
        m = pattern.search(text)
        if m:
            flags.append({"code": code, "label": label, "evidence": m.group(1)})

    brands = list(BRANDS) + [w.strip() for w in str(settings.get("extra_brand_words") or "").split(",") if w.strip()]
    m = _compile(brands).search(text)
    tm = next((p for p in TRADEMARK_PATTERNS if re.search(p, raw, re.I)), None)
    if m or tm:
        flags.append({"code": "brand", "label": "Brand name / trademark (IP infringement risk)",
                      "evidence": m.group(1) if m else re.sub(r"\\b", "", tm)})

    extra = [w.strip() for w in str(settings.get("extra_blocked_words") or "").split(",") if w.strip()]
    if extra:
        m = _compile(extra).search(text)
        if m:
            flags.append({"code": "blocked_word", "label": "Contains one of your blocked words",
                          "evidence": m.group(1)})

    specs = parse_specs(raw)
    dims = specs.get("dims_cm") or []
    if dims and len(dims) >= 3 and max(dims) > 80 and not any(f["code"] == "large_heavy" for f in flags):
        flags.append({"code": "large_heavy", "label": HARD_RULES["large_heavy"][0],
                      "evidence": f"{max(dims):.0f} cm"})
    for val, unit in specs.get("sizes", []):
        if (unit == "kg" and val >= 5) and not any(f["code"] == "large_heavy" for f in flags):
            flags.append({"code": "large_heavy", "label": HARD_RULES["large_heavy"][0], "evidence": f"{val} kg"})

    for f in ai_flags or []:
        if f.get("code") and not any(x["code"] == f["code"] for x in flags):
            flags.append({"code": f["code"], "label": f.get("label") or f["code"],
                          "evidence": f.get("evidence") or "AI check"})

    notes = []
    for code, (label, pattern) in _SOFT.items():
        if pattern.search(normalize(raw)):
            notes.append(label)
    return {"dropped": bool(flags), "flags": flags, "notes": notes}


AI_SYSTEM = (
    "You check products for a Dutch webshop that imports from China and sells on bol.com. "
    "Answer ONLY with JSON: {\"flags\": [{\"code\": one of electronics|kids_toys|cosmetics|food|certification|"
    "clothing_sizes|fragile|large_heavy|brand, \"evidence\": short text}]}. Flag only clear cases. "
    "'brand' = a brand name, licensed character, or 'for <brand>' compatibility claim. "
    "'certification' = needs CE marking or other certification to sell legally in the EU. "
    "Return {\"flags\": []} when nothing applies."
)


def ai_check(ai, title_nl: str, title_en: str, category: str) -> list[dict]:
    if ai is None or not ai.available:
        return []
    out = ai.complete_json("risk", AI_SYSTEM,
                           f"bol title: {title_nl}\nAliExpress title: {title_en}\nCategory: {category}",
                           max_tokens=200)
    if not isinstance(out, dict):
        return []
    valid = set(HARD_RULES) | {"brand"}
    return [f for f in out.get("flags") or [] if isinstance(f, dict) and f.get("code") in valid]
