"""Extra flag - could you produce this yourself on the Roland SG2-540?

The SG2-540 is an eco-solvent print-and-cut printer, 1.37 m wide: vinyl,
stickers, decals, wall/window/car stickers, labels, posters, banners, signs,
canvas prints, window film. We flag those and estimate your own print cost
(area x cost per m2 + labour) so you can compare with importing.
"""
from __future__ import annotations

from typing import Any

from .text import normalize, parse_specs

PRINT_WORDS = {
    "sticker": 0.06, "stickers": 0.06, "decal": 0.06, "muursticker": 0.25, "wall sticker": 0.25,
    "raamsticker": 0.15, "raamstickers": 0.15, "window sticker": 0.15, "window stickers": 0.15,
    "autosticker": 0.03, "car sticker": 0.03, "label": 0.02, "labels": 0.02, "etiket": 0.02,
    "naamstickers": 0.02, "poster": 0.35, "canvas print": 0.35, "wall art": 0.35, "banner": 1.5,
    "spandoek": 1.5, "sign": 0.2, "wandbord": 0.2, "naambord": 0.1, "vinyl": 0.1, "window film": 0.9,
    "raamfolie": 0.9, "static cling": 0.5, "wrap": 0.5, "magneetsticker": 0.03,
}
NOT_PRINTABLE = {"led", "lamp", "metal", "metaal", "wood", "hout", "frame", "lijst", "3d",
                 "acrylic", "acryl", "resin"}


def check(texts: list[str], settings: dict[str, Any]) -> dict[str, Any]:
    text = " " + normalize(" | ".join(t for t in texts if t)) + " "
    hits = [(w, area) for w, area in PRINT_WORDS.items() if f" {normalize(w)} " in text]
    if not hits:
        return {"printable": False}
    word, default_area = max(hits, key=lambda x: x[1])
    blockers = sorted(w for w in NOT_PRINTABLE if f" {w} " in text)
    specs = parse_specs(" ".join(texts))
    dims = specs.get("dims_cm")
    max_w = float(settings["print_max_width_cm"])
    if dims and len(dims) >= 2:
        w_cm, h_cm = sorted(dims[:2])
        area = w_cm * h_cm / 10_000
        fits = w_cm <= max_w
        size_note = f"{dims[0]:g} x {dims[1]:g} cm"
    else:
        area = default_area
        fits = True
        size_note = f"assumed ~{area:.2f} m2"
    count = max(specs.get("counts") or [1])
    if word in {"label", "labels", "etiket", "naamstickers", "sticker", "stickers"} and count > 1:
        area = max(area, 0.0006 * count)  # many small labels on one sheet
    cost = area * float(settings["print_cost_per_m2"]) * 1.15 + float(settings["print_labour_per_unit"])
    printable = fits and not blockers
    reason = (f"'{word}' product, {size_note}" + ("" if fits else f" - wider than your {max_w:.0f} cm media")
              + (f" - but contains {', '.join(blockers)}" if blockers else ""))
    return {"printable": printable, "maybe": bool(blockers) and fits, "reason": reason,
            "area_m2": round(area, 3), "print_cost": round(cost, 2), "fits_width": fits}
