"""Unit tests for the individual funnel steps."""
from datetime import date, timedelta

from app.clients.aliexpress import sign
from app.pipeline import printable, profit, risk
from app.pipeline.demand import analyse_series
from app.pipeline.text import compare_specs, extract_keywords_rule_based, parse_specs


def series(fn, weeks=156, end=date(2026, 10, 26)):
    out = []
    for i in range(weeks - 1, -1, -1):
        d = end - timedelta(weeks=i)
        y, w, _ = d.isocalendar()
        out.append((y, w, int(fn(d, i))))
    return out


def test_emerging_trend_is_rising(settings):
    # flat 200/week, then a fast rise in the last 5 weeks
    s = series(lambda d, i: 200 if i > 5 else 200 * (1.25 ** (6 - i)))
    sig = analyse_series(s, settings)
    assert sig["is_rising"], sig["reasons"]
    assert sig["yoy"] > 1
    assert sig["stage"] == "early"


def test_christmas_peak_is_not_a_trend(settings):
    # same December peak every year: rising now, but just as last year
    def f(d, i):
        wk = d.isocalendar()[1]
        dist = min(abs(wk - 50), 52 - abs(wk - 50))
        return 150 * (1 + 6 * 2.718 ** (-(dist ** 2) / 18))
    sig = analyse_series(series(f), settings)
    assert sig["growth_4w"] > 0.2          # it IS going up right now...
    assert not sig["is_rising"]            # ...but it is seasonal
    assert any("seasonal" in r for r in sig["reasons"])


def test_past_peak_is_rejected(settings):
    s = series(lambda d, i: 200 if i > 14 else (900 if i > 7 else 900 - (8 - i) * 80))
    sig = analyse_series(s, settings)
    assert not sig["is_rising"]


def test_low_volume_is_rejected(settings):
    s = series(lambda d, i: 10 if i > 5 else 10 * (1.3 ** (6 - i)))
    sig = analyse_series(s, settings)
    assert not sig["is_rising"]
    assert any("too few" in r for r in sig["reasons"])


def test_profit_breakdown_adds_up(settings):
    p = profit.calculate(24.99, 3.40, None, "small", settings)
    total = sum(line["amount"] for line in p["lines"])
    assert abs(total - p["profit"]) < 0.05
    # spot-check: VAT is 21/121 of the sale price
    vat = next(l for l in p["lines"] if l["label"].startswith("VAT"))
    assert abs(-vat["amount"] - 24.99 * 21 / 121) < 0.01
    assert p["shipping_estimated"]


def test_profit_settings_change_result(settings):
    base = profit.calculate(20.0, 3.0, 1.0, "small", settings)["profit"]
    settings["bol_commission_pct"] = 0.08
    assert profit.calculate(20.0, 3.0, 1.0, "small", settings)["profit"] > base
    settings["fulfilment_method"] = "FBR"
    assert "Own shipping" in profit.calculate(20.0, 3.0, 1.0, "small", settings)["lines"][4]["label"]


def test_fixed_fee_tiers():
    tiers = [[10, 0.2], [20, 0.45], [None, 0.99]]
    assert profit.bol_fixed_fee(9.99, tiers) == 0.2
    assert profit.bol_fixed_fee(15, tiers) == 0.45
    assert profit.bol_fixed_fee(99, tiers) == 0.99


def test_risk_filter(settings):
    dropped = {
        "Magnetic LED Night Light Rechargeable": "electronics",
        "Kids Play Tent Teepee Toy House": "kids_toys",
        "Vitamin C Face Serum 30ml": "cosmetics",
        "Organic Matcha Green Tea Powder": "food",
        "Phone Case for iPhone 16": "brand",
        "Oversized Hoodie Women Size S-XXL": "clothing_sizes",
        "Round Wall Mirror Gold 60cm": "fragile",
        "Giant Bean Bag Chair Cover": "large_heavy",
        "Bicycle helmet adult": "certification",
    }
    for title, code in dropped.items():
        res = risk.check([title], settings)
        assert res["dropped"], title
        assert code in {f["code"] for f in res["flags"]}, (title, res["flags"])
    for title in ["Foldable Shoe Rack 6 Tier", "Privacy Window Film Frosted Glass Sticker 45x200cm",
                  "Magnetic Spice Rack Fridge Organizer", "Moon Phase Wall Sticker Vinyl Decal",
                  "Pet Hair Remover Roller for Furniture"]:
        assert not risk.check([title], settings)["dropped"], title


def test_extra_blocked_words(settings):
    settings["extra_blocked_words"] = "candle, kaars"
    assert risk.check(["Scented soy kaars"], settings)["dropped"]


def test_printable_flag(settings):
    p = printable.check(["Moon Phase Wall Sticker Vinyl Decal 60x30cm"], settings)
    assert p["printable"] and p["fits_width"] and p["print_cost"] > 0
    assert not printable.check(["Magnetic Spice Rack"], settings)["printable"]
    wide = printable.check(["Wall sticker mural 150x200cm"], settings)
    assert not wide["printable"] and not wide["fits_width"]


def test_keyword_extraction_rule_based():
    kws = extract_keywords_rule_based("Magnetic Spice Rack Fridge Organizer Shelf")
    assert {"nl": "kruidenrek", "en": "spice rack"} in kws
    assert {"nl": "magnetisch kruidenrek", "en": "magnetic spice rack"} in kws
    assert extract_keywords_rule_based("Unknown gizmo thing 2024") == []


def test_specs():
    a = parse_specs("Wall sticker 60x30cm 2pcs")
    b = parse_specs("Muursticker 60 x 30 cm - 2 stuks")
    score, notes = compare_specs(a, b)
    assert score > 0 and "same size" in notes
    assert compare_specs(a, parse_specs("Sticker 40x20cm"))[0] < 0


def test_aliexpress_signature_is_deterministic():
    p = {"app_key": "k", "method": "m", "timestamp": "1", "sign_method": "sha256"}
    assert sign(p, "secret") == sign(dict(reversed(list(p.items()))), "secret")
    assert sign(p, "secret") != sign(p, "other")
    assert sign(p, "secret").isupper() and len(sign(p, "secret")) == 64
