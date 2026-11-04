"""Step 5 - Real profit per unit: what you actually keep.

    sale price (incl. 21% VAT)
  - VAT you pay to the tax office
  - bol commission (% of sale price) and fixed fee per item
  - fulfilment (Logistiek via bol, or your own shipping) + packaging
  - AliExpress product price + shipping to NL
  - import VAT (optional, see settings) + customs/handling fee per order
  - returns allowance
  = profit per unit
All rates come from Settings.
"""
from __future__ import annotations

from statistics import median
from typing import Any

LARGE_WORDS = {"rack", "stand", "shelf", "tent", "chair", "mat", "basket", "caddy", "rek", "standaard",
               "box", "mirror", "planter", "organizer", "tray", "bag"}
SMALL_WORDS = {"sticker", "stickers", "decal", "label", "labels", "poster", "film", "folie", "liner",
               "stopper", "case", "hoesje", "roller", "card"}


def size_class(title: str, dims_cm: list[float] | None = None) -> str:
    """small = fits a mailbox parcel, medium = normal parcel, large = big parcel."""
    if dims_cm:
        longest = max(dims_cm)
        if len(dims_cm) >= 3 and longest > 60:
            return "large"
    words = set(title.lower().split())
    if words & SMALL_WORDS:
        return "small"
    if words & LARGE_WORDS:
        return "medium"
    return "small"


def bol_fixed_fee(price: float, tiers: list[list[Any]]) -> float:
    for max_price, fee in tiers:
        if max_price is None or price <= float(max_price):
            return float(fee)
    return float(tiers[-1][1]) if tiers else 0.0


def choose_sale_price(competitor_prices: list[float], settings: dict[str, Any]) -> float | None:
    prices = sorted(p for p in competitor_prices if p)
    if not prices:
        return None
    strategy = settings["pricing_strategy"]
    if strategy == "lowest":
        return round(prices[0], 2)
    if strategy == "undercut":
        return round(prices[0] * (1 - settings["undercut_pct"]), 2)
    return round(median(prices), 2)


def calculate(sale_price: float, ali_price: float, ali_shipping: float | None, size: str,
              settings: dict[str, Any]) -> dict[str, Any]:
    s = settings
    vat = sale_price - sale_price / (1 + s["vat_rate"])
    revenue_ex_vat = sale_price - vat
    commission = sale_price * s["bol_commission_pct"]
    fixed_fee = bol_fixed_fee(sale_price, s["bol_fixed_fee_tiers"])
    if s["fulfilment_method"] == "FBB":
        fulfilment = s[f"fbb_fee_{size}"] + s["fbb_storage_per_unit"]
        fulfilment_label = f"Logistiek via bol ({size})"
    else:
        fulfilment = s[f"fbr_shipping_{size}"]
        fulfilment_label = f"Own shipping ({size})"
    packaging = s["packaging_cost"]
    shipping_estimated = ali_shipping is None
    shipping = s[f"inbound_shipping_{size}"] if shipping_estimated else ali_shipping
    import_vat = 0.0
    if s["count_import_vat_as_cost"] and not s["ali_price_includes_vat"]:
        import_vat = (ali_price + shipping) * s["import_vat_rate"]
    customs = s["customs_fee_per_order"] / max(1, s["units_per_order"])
    landed = ali_price + shipping + import_vat + customs
    returns = s["returns_rate"] * (landed + s["return_handling_cost"])
    costs = commission + fixed_fee + fulfilment + packaging + landed + returns
    profit = revenue_ex_vat - costs
    margin = profit / revenue_ex_vat if revenue_ex_vat else 0.0
    roi = profit / landed if landed else 0.0

    lines = [
        ("Sale price on bol (incl. VAT)", sale_price),
        (f"VAT {s['vat_rate']:.0%}", -vat),
        (f"bol commission {s['bol_commission_pct']:.0%}", -commission),
        ("bol fixed fee", -fixed_fee),
        (fulfilment_label, -fulfilment),
        ("Packaging", -packaging),
        ("AliExpress price", -ali_price),
        ("Shipping to NL" + (" (estimate)" if shipping_estimated else ""), -shipping),
        ("Import VAT", -import_vat),
        (f"Customs/handling (per order / {s['units_per_order']})", -customs),
        (f"Returns allowance ({s['returns_rate']:.0%})", -returns),
    ]
    return {
        "sale_price": round(sale_price, 2),
        "revenue_ex_vat": round(revenue_ex_vat, 2),
        "landed_cost": round(landed, 2),
        "profit": round(profit, 2),
        "margin": round(margin, 3),
        "roi": round(roi, 2),
        "size": size,
        "shipping_estimated": shipping_estimated,
        "lines": [{"label": label, "amount": round(amount, 2)} for label, amount in lines if abs(amount) > 0.004],
    }
