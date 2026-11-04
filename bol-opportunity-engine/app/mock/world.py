"""A deterministic simulated market for DEMO MODE.

It contains a few dozen product concepts with realistic behaviour:
emerging trends, a Christmas-only seasonal product (must be rejected),
a product past its peak, stable evergreen products, and risky products
(electronics, toys, cosmetics, food, brands, clothing, fragile, large) that
the risk filter must drop. The market *evolves* day by day from an anchor date,
so running the demo on consecutive days shows trends growing, peaking and
competition arriving - just like the real thing.
"""
from __future__ import annotations

import hashlib
import math
from dataclasses import dataclass, field
from datetime import date, timedelta

from ..pipeline.text import content_tokens


@dataclass
class Concept:
    code: int
    nl: str
    en: str
    ali_title: str
    cat1: str
    cat2: str
    trend: str                 # emerging | peaked | seasonal | stable
    base: int                  # weekly searches before the trend
    bol_price: float
    ali_price: float
    offers: int                # sellers per top EAN at the anchor date
    reviews: int               # reviews on the top EAN at the anchor date
    nl_desc: list[str]
    aliases: dict[str, float] = field(default_factory=dict)
    related: list[str] = field(default_factory=list)
    mid: float = 0.0           # weeks after anchor where growth is fastest
    amp: float = 3.0           # trend height (x base)
    peak_week: int = 51        # seasonal peak (ISO week)
    yoy: float = 0.03          # yearly organic growth
    hot: bool = True           # appears in AliExpress hot products
    volume: int = 3000         # AliExpress recent sales


C = Concept
CONCEPTS: list[Concept] = [
    C(1, "kruidenrek", "spice rack", "Magnetic Spice Rack Fridge Organizer Shelf Kitchen Storage Holder 3 Tier",
      "Home & Garden", "Kitchen Storage", "emerging", 220, 32.99, 4.20, 2, 6,
      ["magnetisch", "voor koelkast", "3 lagen", "zwart metaal"],
      {"magnetisch kruidenrek": 0.45, "kruidenrek koelkast": 0.25}, ["opbergrek keuken"], mid=2, amp=3.5,
      volume=8400),
    C(2, "maanfasen muursticker", "moon phase wall sticker", "Moon Phase Wall Sticker Boho Bedroom Vinyl Decal 60x30cm",
      "Home & Garden", "Wall Stickers", "emerging", 180, 19.99, 1.60, 1, 3,
      ["maan", "boho", "slaapkamer", "60x30 cm", "zwart vinyl"],
      {"muursticker maan": 0.4, "boho muursticker": 0.3}, ["naamstickers"], mid=1, amp=4.0, volume=5200),
    C(3, "kabel organizer", "cable organizer", "Under Desk Cable Organizer Tray Cable Management Rack Metal",
      "Home Improvement", "Storage", "emerging", 400, 27.99, 4.50, 4, 35,
      ["onder bureau", "kabelgoot", "metaal", "zwart"], {"kabelgoot bureau": 0.35}, [], mid=-1, amp=2.4,
      volume=6100),
    C(4, "airfryer bakjes", "air fryer liner", "Silicone Air Fryer Liner Reusable Basket Pot 20cm 2pcs",
      "Home & Garden", "Kitchen Accessories", "emerging", 900, 12.99, 1.40, 16, 900,
      ["siliconen", "herbruikbaar", "20 cm", "2 stuks"], {"siliconen airfryer bakjes": 0.5}, [], mid=-3,
      amp=1.6, volume=25000),
    C(5, "raamfolie", "window film", "Privacy Window Film Frosted Static Cling Glass Sticker 45x200cm",
      "Home Improvement", "Window Film", "emerging", 350, 24.99, 3.40, 3, 20,
      ["privacy", "matglas", "statisch", "45x200 cm"], {"privacy raamfolie": 0.5, "raamfolie matglas": 0.3},
      ["douchemandje zonder boren"], mid=1, amp=2.8, volume=7300),
    C(6, "hangende plantenbak", "hanging planter", "Macrame Hanging Planter Basket Indoor Wall Plant Hanger 4pcs",
      "Home & Garden", "Garden Supplies", "emerging", 260, 29.99, 2.60, 2, 11,
      ["macramé", "binnen", "4 stuks", "katoen"], {"macramé plantenhanger": 0.4}, [], mid=5, amp=3.0,
      volume=3900),
    C(7, "deurstopper", "door stopper", "Silicone Door Stopper Wall Protector Self Adhesive 6pcs",
      "Home Improvement", "Hardware", "stable", 900, 7.99, 0.90, 12, 800, ["zelfklevend", "6 stuks"],
      volume=15000),
    C(8, "laptopstandaard", "laptop stand", "Adjustable Laptop Stand Aluminum Foldable Desk Holder",
      "Computer & Office", "Laptop Accessories", "peaked", 700, 24.99, 7.50, 9, 300,
      ["verstelbaar", "aluminium", "opvouwbaar"], mid=-14, amp=2.5, volume=12000),
    C(9, "kerst raamstickers", "christmas window sticker",
      "Christmas Window Stickers Snowflake Static Cling Decoration 9 Sheets",
      "Home & Garden", "Festive Supplies", "seasonal", 120, 8.99, 1.40, 6, 120,
      ["sneeuwvlok", "statisch", "9 vellen"], {"raamstickers kerst": 0.5}, [], amp=7.0, peak_week=50, yoy=0.04,
      volume=9000),
    C(10, "nachtlampje", "night light", "Magnetic LED Night Light Motion Sensor Rechargeable Wall Lamp",
      "Lights & Lighting", "Night Lights", "emerging", 600, 19.99, 3.20, 3, 15,
      ["led", "bewegingssensor", "oplaadbaar"], mid=1, amp=3.0, volume=30000),
    C(11, "speeltent", "play tent", "Kids Play Tent Teepee Toy House Indoor Castle",
      "Toys & Hobbies", "Play Tents", "emerging", 300, 39.99, 11.0, 2, 8, ["kinderen", "speelgoed"],
      {"kinder speeltent": 0.5}, mid=2, amp=2.5, volume=4000),
    C(12, "gezichtsserum", "face serum", "Vitamin C Face Serum Whitening Skin Care 30ml",
      "Beauty & Health", "Skin Care", "emerging", 500, 14.99, 1.80, 4, 40, ["vitamine c", "30 ml"],
      mid=1, amp=2.5, volume=20000),
    C(13, "matcha poeder", "matcha powder", "Organic Matcha Green Tea Powder 100g",
      "Food", "Tea", "emerging", 450, 12.99, 3.00, 5, 60, ["biologisch", "100 gram"], mid=0, amp=2.0,
      volume=11000),
    C(14, "telefoonhoesje", "phone case", "Shockproof Clear Phone Case for iPhone 16 Pro Max Magnetic Cover",
      "Cellphones & Telecommunications", "Phone Cases", "emerging", 2000, 12.99, 1.20, 30, 2000,
      ["iphone 16", "transparant"], mid=0, amp=1.5, volume=50000),
    C(15, "oversized hoodie", "oversized hoodie", "Oversized Hoodie Women Fleece Pullover Size S-XXL",
      "Women's Clothing", "Hoodies", "emerging", 800, 29.99, 9.0, 8, 200, ["dames", "fleece", "maat s-xxl"],
      mid=1, amp=2.0, volume=18000),
    C(16, "ronde wandspiegel", "round wall mirror", "Round Wall Mirror Gold Metal Frame 60cm",
      "Home & Garden", "Mirrors", "emerging", 300, 49.99, 14.0, 3, 25, ["goud", "60 cm", "glas"],
      mid=2, amp=2.5, volume=2500),
    C(17, "schoenenrek", "shoe rack", "Foldable Shoe Rack 6 Tier Storage Organizer",
      "Home & Garden", "Home Storage", "stable", 1500, 24.99, 8.0, 15, 1500, ["6 lagen", "opvouwbaar"],
      volume=9000),
    C(18, "abstracte poster", "abstract poster", "Abstract Poster Boho Wall Art Canvas Print 50x70cm",
      "Home & Garden", "Painting & Calligraphy", "emerging", 300, 19.99, 1.90, 3, 14,
      ["boho", "50x70 cm", "woonkamer", "canvas"], {"boho poster": 0.4, "poster woonkamer": 0.3}, [],
      mid=2, amp=3.0, volume=6600),
    C(19, "sleutelrek", "key holder", "Wall Mounted Key Holder Wooden Organizer with 5 Hooks",
      "Home & Garden", "Home Storage", "emerging", 240, 27.99, 3.20, 2, 22,
      ["houten", "5 haken", "muur"], {"sleutelrek hout": 0.4}, [], mid=0, amp=2.8, volume=4100),
    C(20, "autosticker", "car sticker", "Funny Car Sticker Vinyl Decal Waterproof 15cm",
      "Automobiles & Motorcycles", "Car Stickers", "stable", 500, 6.99, 0.70, 10, 400,
      ["grappige", "vinyl", "waterdicht", "15 cm"], volume=7000),
    C(21, "bureau organizer", "desk organizer", "Rotating Desk Organizer Pen Holder Storage Box 360 Degree",
      "Computer & Office", "Desk Accessories", "emerging", 280, 28.99, 3.80, 2, 9,
      ["draaibaar", "pennenhouder", "opbergbox"], {"draaibare bureau organizer": 0.4}, [], mid=1, amp=3.2,
      volume=5700),
    C(22, "douchemandje zonder boren", "shower caddy", "Shower Caddy No Drilling Adhesive Bathroom Shelf Rack 2 Pack",
      "Home & Garden", "Bathroom Storage", "emerging", 330, 27.99, 4.60, 3, 17,
      ["zonder boren", "zelfklevend", "badkamer", "2 stuks"], {"douchemandje": 0.6}, [], mid=2, amp=3.0,
      hot=False, volume=6800),
    C(23, "naamstickers", "name labels", "Custom Name Labels Waterproof Vinyl Stickers 120pcs School",
      "Office & School Supplies", "Labels", "emerging", 210, 14.99, 1.40, 1, 4,
      ["gepersonaliseerde", "waterdicht", "120 stuks", "school"], {"naamstickers kinderen": 0.3}, [],
      mid=0, amp=3.0, hot=False, volume=3100),
    C(24, "huisdierhaar roller", "pet hair remover", "Pet Hair Remover Roller Reusable Lint Brush for Furniture",
      "Home & Garden", "Pet Products", "emerging", 260, 19.99, 2.10, 2, 12,
      ["herbruikbaar", "meubels", "huisdieren"], {"pluizenroller huisdieren": 0.4}, [], mid=2, amp=3.0,
      volume=7800),
    C(25, "zitzak", "bean bag", "Giant Bean Bag Chair Cover XXL 150cm",
      "Furniture", "Living Room Furniture", "emerging", 400, 59.99, 18.0, 4, 30, ["xxl", "150 cm"],
      {"grote zitzak": 0.4}, mid=1, amp=2.5, volume=2000),
    C(26, "lunchbox", "bento lunch box", "Bento Lunch Box 3 Compartment Leakproof Container",
      "Home & Garden", "Kitchen Storage", "seasonal", 600, 12.99, 2.50, 8, 300, ["3 vakken", "lekvrij"],
      {"bento lunchbox": 0.4}, [], amp=2.5, peak_week=35, volume=9500),
    C(27, "yogamat", "yoga mat", "Non Slip Yoga Mat 6mm TPE Exercise Mat 183x61cm",
      "Sports & Entertainment", "Yoga Mats", "stable", 2500, 19.99, 6.0, 20, 3000, ["antislip", "6 mm"],
      volume=14000),
]
BY_CODE = {c.code: c for c in CONCEPTS}


def h(*parts: object) -> int:
    return int(hashlib.sha256("|".join(map(str, parts)).encode()).hexdigest()[:12], 16)


def unit(*parts: object) -> float:
    """Deterministic pseudo-random number in [0, 1)."""
    return (h(*parts) % 1_000_000) / 1_000_000


def ean13(body12: str) -> str:
    total = sum(int(d) * (3 if i % 2 else 1) for i, d in enumerate(body12))
    return body12 + str((10 - total % 10) % 10)


def monday(d: date) -> date:
    return d - timedelta(days=d.weekday())


class DemoWorld:
    def __init__(self, anchor: date, today: date):
        self.anchor = monday(anchor)
        self.today = today
        self._term_index: dict[str, tuple[Concept, float]] = {}
        for c in CONCEPTS:
            self._term_index[c.nl] = (c, 1.0)
            for alias, factor in c.aliases.items():
                self._term_index[alias] = (c, factor)

    # ---- search terms ------------------------------------------------------
    def resolve(self, term: str) -> tuple[Concept | None, float]:
        """Which concept does a search term belong to (and how much of its volume)?"""
        t = term.strip().lower()
        if t in self._term_index:
            return self._term_index[t]
        q = content_tokens(t)
        best, best_j = None, 0.0
        for known, (c, factor) in self._term_index.items():
            k = content_tokens(known)
            if not q or not k:
                continue
            j = len(q & k) / len(q | k)
            if j > best_j:
                best, best_j = (c, factor), j
        if best and best_j >= 0.5:
            c, factor = best
            return c, factor * (0.3 + 0.4 * unit("alias", t))
        return None, 0.0

    def weekly_value(self, term: str, week_start: date) -> int:
        c, factor = self.resolve(term)
        t = (monday(week_start) - self.anchor).days / 7.0
        noise = 1 + (unit("noise", term, week_start.isoformat()) - 0.5) * 0.10
        if c is None:
            base = 15 + 90 * unit("unknown", term)
            return max(0, int(base * noise))
        v = c.base * self._shape(c, t, week_start) * factor * noise
        return max(0, int(round(v)))

    def _shape(self, c: Concept, t: float, week_start: date) -> float:
        growth = (1 + c.yoy) ** (t / 52.0)
        if c.trend == "emerging":
            s = 1 / (1 + math.exp(-(t - c.mid) / 2.2))
            v = 1 + c.amp * s
            fade_start = c.mid + 9
            if t > fade_start:  # hypes fade eventually
                v = 1 + (v - 1) * math.exp(-(t - fade_start) / 10)
            return v * growth
        if c.trend == "peaked":
            peak = c.mid + 6
            s = 1 / (1 + math.exp(-(t - c.mid) / 2.0))
            v = 1 + c.amp * s
            if t > peak:
                v = 1 + (v - 1) * math.exp(-(t - peak) / 5)
            return v * growth
        if c.trend == "seasonal":
            wk = week_start.isocalendar()[1]
            d = min(abs(wk - c.peak_week), 52 - abs(wk - c.peak_week))
            return (1 + c.amp * math.exp(-(d ** 2) / (2 * 3.0 ** 2))) * growth
        return growth  # stable

    def search_terms(self, term: str, periods: int) -> dict:
        last_full_week = monday(self.today) - timedelta(days=7)
        out = []
        total = 0
        for i in range(periods - 1, -1, -1):
            ws = last_full_week - timedelta(days=7 * i)
            if ws < self.anchor - timedelta(days=7 * 208):
                continue
            iso = ws.isocalendar()
            v = self.weekly_value(term, ws)
            total += v
            out.append({"period": {"week": iso[1], "year": iso[0]}, "total": v,
                        "countries": [{"countryCode": "NL", "total": v}]})
        c, _ = self.resolve(term)
        related = []
        if c is not None:
            names = [c.nl, *c.aliases.keys(), *c.related]
            for name in names:
                if name.lower() != term.lower():
                    rv = sum(self.weekly_value(name, last_full_week - timedelta(days=7 * i)) for i in range(12))
                    related.append({"searchTerm": name, "total": rv})
        return {"searchTerms": {"searchTerm": term, "type": "SEARCH_TERM", "total": total,
                                "countries": [{"countryCode": "NL", "total": total}],
                                "periods": out, "relatedSearchTerms": related}}

    # ---- bol products ------------------------------------------------------
    def days(self, on: date | None = None) -> int:
        return max(0, ((on or self.today) - self.anchor).days)

    def products_for(self, term: str) -> list[dict]:
        c, _ = self.resolve(term)
        n = 8
        out = []
        for i in range(n):
            ean = self.ean_for(c, i, term)
            out.append({"ean": ean, "title": self.bol_title(c, i, term)})
        return out

    def ean_for(self, c: Concept | None, i: int, term: str = "") -> str:
        if c is None:
            body = f"879{h('u', term) % 10**9:09d}"
        else:
            body = f"87{c.code:03d}{i:02d}{h('ean', c.code, i) % 100000:05d}"
        return ean13(body[:12])

    def parse_ean(self, ean: str) -> tuple[Concept | None, int]:
        if len(ean) == 13 and ean.startswith("87") and ean[2] != "9":
            code, idx = int(ean[2:5]), int(ean[5:7])
            return BY_CODE.get(code), idx
        return None, 0

    def bol_title(self, c: Concept | None, i: int, term: str = "") -> str:
        if c is None:
            return f"{term.capitalize()} - artikel {i + 1}"
        desc = c.nl_desc
        picks = [desc[(i + k) % len(desc)] for k in range(1 + (i % 3))] if desc else []
        base = c.nl.capitalize()
        if i == 0:
            picks = desc[:3]
        if i >= 6:  # a couple of weak, short listings
            return base
        return " - ".join([base, *picks])

    def offers_count(self, c: Concept | None, i: int, on: date | None = None) -> int:
        if c is None:
            return 1 + i % 3
        growth = self.days(on) * (0.12 if c.trend == "emerging" else 0.02)
        rank_factor = 1.0 if i < 2 else 0.6
        return max(1, int(round((c.offers + growth) * rank_factor + unit("off", c.code, i) * 2)))

    def reviews(self, c: Concept | None, i: int, on: date | None = None) -> int:
        if c is None:
            return int(unit("rev", i) * 10)
        growth = self.days(on) * (0.6 if c.trend == "emerging" else 1.5)
        return max(0, int((c.reviews + growth) * (1.0 / (1 + i * 0.6)) * (0.6 + unit("rv", c.code, i) * 0.8)))

    def price(self, c: Concept | None, i: int) -> float:
        if c is None:
            return round(9.99 + i, 2)
        p = c.bol_price * (0.85 + unit("price", c.code, i) * 0.35)
        return round(math.floor(p) + 0.99 if p > 5 else round(p, 2), 2)

    def ranks(self, ean: str, on: date) -> list[dict]:
        c, i = self.parse_ean(ean)
        if c is None:
            return []
        out = []
        for term in [c.nl, *list(c.aliases)[:2]]:
            week_vol = self.weekly_value(term, monday(on) - timedelta(days=7))
            rank = max(1, i + 1 + int(unit("rank", ean, on.isoformat(), term) * 3) - 1)
            ctr = 1 / (rank ** 0.7)
            out.append({"countryCode": "NL", "searchTerm": term, "categoryId": None, "rank": rank,
                        "impressions": int(week_vol / 7 * 6 * ctr), "wrongLanguageReason": None,
                        "sponsored": False})
        return out

    # ---- AliExpress --------------------------------------------------------
    def ali_products_for(self, c: Concept) -> list[dict]:
        """The real match plus two near-variants."""
        out = [self._ali(c, 0, c.ali_title, c.ali_price, c.volume)]
        alt_title = c.ali_title
        for a, b in (("60x30cm", "40x20cm"), ("45x200cm", "60x300cm"), ("50x70cm", "30x40cm"),
                     ("20cm", "16cm"), ("4pcs", "2pcs"), ("3 Tier", "2 Tier"), ("5 Hooks", "3 Hooks"),
                     ("120pcs", "60pcs"), ("2 Pack", "1 Pack")):
            alt_title = alt_title.replace(a, b)
        if alt_title == c.ali_title:
            alt_title = c.ali_title + " Mini"
        out.append(self._ali(c, 1, alt_title, c.ali_price * 0.8, int(c.volume * 0.4)))
        out.append(self._ali(c, 2, "2024 New " + c.ali_title + " Bundle Set", c.ali_price * 1.7,
                             int(c.volume * 0.15)))
        return out

    def _ali(self, c: Concept, variant: int, title: str, price: float, volume: int) -> dict:
        pid = f"1005{c.code:03d}{variant:02d}{h('ali', c.code, variant) % 1000000:06d}"
        grow = 1 + self.days() * (0.02 if c.trend == "emerging" else 0.002)
        price = round(price * (0.95 + unit("ap", pid) * 0.1), 2)
        return {
            "product_id": int(pid),
            "product_title": title,
            "product_main_image_url": f"/demo-img/ali/{pid}.svg",
            "product_small_image_urls": {"string": [f"/demo-img/ali/{pid}.svg"]},
            "product_detail_url": f"https://www.aliexpress.com/item/{pid}.html",
            "promotion_link": f"https://www.aliexpress.com/item/{pid}.html",
            "target_sale_price": f"{price:.2f}",
            "target_sale_price_currency": "EUR",
            "target_original_price": f"{price * 1.8:.2f}",
            "lastest_volume": int(volume * grow),
            "evaluate_rate": f"{92 + unit('er', pid) * 7.5:.1f}%",
            "first_level_category_id": 100 + c.code,
            "first_level_category_name": c.cat1,
            "second_level_category_id": 1000 + c.code,
            "second_level_category_name": c.cat2,
            "shop_id": 900000 + c.code,
            "ship_to_days": str(8 + c.code % 7),
        }

    def ali_hot(self, page: int, page_size: int) -> list[dict]:
        items = [p for c in CONCEPTS if c.hot for p in self.ali_products_for(c)[:1]]
        items.sort(key=lambda p: -p["lastest_volume"])
        start = (page - 1) * page_size
        return items[start:start + page_size]

    def ali_search(self, keywords: str, page_size: int) -> list[dict]:
        q = content_tokens(keywords)
        scored = []
        for c in CONCEPTS:
            k = content_tokens(c.ali_title + " " + c.en)
            overlap = len(q & k)
            if overlap:
                scored.append((overlap / max(1, len(q)), c))
        scored.sort(key=lambda x: -x[0])
        out: list[dict] = []
        for rank, (_s, c) in enumerate(scored[:3]):
            out.extend(self.ali_products_for(c) if rank == 0 else self.ali_products_for(c)[:1])
        return out[:page_size]
