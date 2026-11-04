"""Editable business settings (fees, thresholds, weights).

Defaults live here; your changes are stored in the database (table `settings`)
and edited on the dashboard's Settings page. The defaults are reasonable
starting points, NOT official tariffs: check bol's current tariff sheet in your
seller dashboard and update them.
"""
from __future__ import annotations

import json
import sqlite3
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class Setting:
    key: str
    default: Any
    type: str  # "float", "int", "bool", "str", "choice", "json", "text"
    group: str
    label: str
    help: str = ""
    choices: tuple[str, ...] = ()


SCHEMA: list[Setting] = [
    # --- Profit -----------------------------------------------------------
    Setting("vat_rate", 0.21, "float", "Profit", "Dutch VAT rate",
            "21% BTW is included in the bol sale price and taken off first."),
    Setting("bol_commission_pct", 0.15, "float", "Profit", "bol commission (fraction of sale price incl. VAT)",
            "Varies per category (roughly 5-17%). Check bol's tariff list."),
    Setting("bol_fixed_fee_tiers", [[10.0, 0.20], [20.0, 0.45], [None, 0.99]], "json", "Profit",
            "bol fixed fee per item, by price tier",
            "List of [max sale price, fee]. null = no upper limit. Example values; check your tariff list."),
    Setting("fulfilment_method", "FBB", "choice", "Profit", "Fulfilment method",
            "FBB = Logistiek via bol (bol stores and ships). FBR = you ship yourself.",
            ("FBB", "FBR")),
    Setting("fbb_fee_small", 2.95, "float", "Profit", "FBB fee per unit - small (mailbox size)"),
    Setting("fbb_fee_medium", 4.25, "float", "Profit", "FBB fee per unit - medium"),
    Setting("fbb_fee_large", 6.50, "float", "Profit", "FBB fee per unit - large"),
    Setting("fbb_storage_per_unit", 0.15, "float", "Profit", "FBB storage cost per unit (average)",
            "Average storage cost a unit incurs before it sells."),
    Setting("fbr_shipping_small", 4.25, "float", "Profit", "Own shipping per unit - small (brievenbuspakje)"),
    Setting("fbr_shipping_medium", 6.95, "float", "Profit", "Own shipping per unit - medium"),
    Setting("fbr_shipping_large", 13.95, "float", "Profit", "Own shipping per unit - large"),
    Setting("packaging_cost", 0.30, "float", "Profit", "Packaging / labels per unit"),
    Setting("inbound_shipping_small", 1.80, "float", "Profit", "AliExpress -> NL shipping estimate per unit - small",
            "Used when the AliExpress API does not return a shipping cost."),
    Setting("inbound_shipping_medium", 3.50, "float", "Profit", "AliExpress -> NL shipping estimate per unit - medium"),
    Setting("inbound_shipping_large", 7.50, "float", "Profit", "AliExpress -> NL shipping estimate per unit - large"),
    Setting("import_vat_rate", 0.21, "float", "Profit", "Import VAT rate on goods + shipping"),
    Setting("count_import_vat_as_cost", True, "bool", "Profit", "Count import VAT as a cost",
            "If you are VAT-registered you can usually reclaim it; leave on to be conservative."),
    Setting("ali_price_includes_vat", False, "bool", "Profit", "AliExpress price already includes import VAT",
            "AliExpress often charges VAT at checkout for EU buyers (IOSS). Turn on if your price includes it."),
    Setting("customs_fee_per_order", 3.00, "float", "Profit", "Customs / handling fee per order",
            "EU low-value parcel duty/handling. Check the current rules."),
    Setting("units_per_order", 10, "int", "Profit", "Units you buy per AliExpress order",
            "Per-order fees are spread over this many units."),
    Setting("returns_rate", 0.05, "float", "Profit", "Expected return rate"),
    Setting("return_handling_cost", 2.50, "float", "Profit", "Extra cost per returned unit",
            "Return shipping/handling. A returned unit is assumed to be lost (conservative)."),
    Setting("pricing_strategy", "median", "choice", "Profit", "Your sale price",
            "median = median of top bol competitors; lowest = match cheapest; undercut = cheapest minus a %.",
            ("median", "lowest", "undercut")),
    Setting("undercut_pct", 0.03, "float", "Profit", "Undercut percentage (for 'undercut')"),
    Setting("min_profit_eur", 3.00, "float", "Profit", "Minimum profit per unit (EUR)",
            "Opportunities below this are moved to 'Filtered out'."),
    Setting("min_margin_pct", 0.15, "float", "Profit", "Minimum margin (profit / revenue ex VAT)"),

    # --- Demand -----------------------------------------------------------
    Setting("min_weekly_volume", 150, "int", "Demand", "Minimum searches per week",
            "Average over the last 4 weeks. Below this the demand is too small."),
    Setting("min_wow_growth", 0.15, "float", "Demand", "Minimum growth: last 4 weeks vs the 4 before"),
    Setting("min_yoy_growth", 0.30, "float", "Demand", "Minimum growth vs the same weeks last year"),
    Setting("min_excess_growth", 0.10, "float", "Demand", "Minimum growth above last year's seasonal growth",
            "Christmas-type peaks grow every year; we only count growth that is bigger than last year's."),
    Setting("history_weeks", 156, "int", "Demand", "Weeks of search history to request (max 4 years = 208)"),
    Setting("max_keywords_per_run", 80, "int", "Demand", "Max keywords checked per daily run",
            "Keeps the run inside bol's API rate limits. Least-recently checked first."),
    Setting("max_new_keywords_per_run", 40, "int", "Demand", "Max new keywords added per run (per source)",
            "Applies separately to AliExpress seeds and to bol related search terms."),
    Setting("dormant_after_checks", 6, "int", "Demand", "Park a keyword after this many flat checks",
            "Parked keywords are only re-checked weekly."),

    # --- Competition ----------------------------------------------------
    Setting("top_products_per_keyword", 5, "int", "Competition", "bol products analysed per keyword"),
    Setting("max_tracked_eans", 400, "int", "Competition", "Max EANs tracked daily (ranks, offers)"),
    Setting("rank_backfill_weeks", 8, "int", "Competition", "Backfill rank history for new EANs (weeks, max 12)",
            "bol keeps only ~3 months; one sample per week is fetched the first time we see an EAN."),

    # --- Matching -------------------------------------------------------
    Setting("min_match_confidence", 0.50, "float", "Matching", "Minimum AliExpress match confidence"),
    Setting("ali_candidates_per_keyword", 10, "int", "Matching", "AliExpress candidates compared per keyword"),

    # --- Scoring --------------------------------------------------------
    Setting("weight_demand", 0.25, "float", "Scoring", "Weight: demand growth"),
    Setting("weight_earliness", 0.20, "float", "Scoring", "Weight: earliness (not at the peak yet)"),
    Setting("weight_competition", 0.20, "float", "Scoring", "Weight: weak competition"),
    Setting("weight_profit", 0.20, "float", "Scoring", "Weight: profit"),
    Setting("weight_match", 0.15, "float", "Scoring", "Weight: AliExpress match confidence"),
    Setting("learning_strength", 0.5, "float", "Scoring", "How strongly your decisions re-rank (0 = off, 1 = strong)"),
    Setting("resuggest_rejected_after_days", 30, "int", "Scoring", "Show a rejected item again after (days)",
            "Only if its score improved by 15+ points."),

    # --- Risk -----------------------------------------------------------
    Setting("extra_blocked_words", "", "text", "Risk", "Extra blocked words (comma separated)",
            "Any product whose title contains one of these is dropped."),
    Setting("extra_brand_words", "", "text", "Risk", "Extra brand / trademark words (comma separated)"),

    # --- Printing -------------------------------------------------------
    Setting("print_cost_per_m2", 9.00, "float", "Printing", "Roland print cost per m2 (vinyl + ink + laminate)"),
    Setting("print_labour_per_unit", 0.75, "float", "Printing", "Cutting/weeding/packing labour per unit"),
    Setting("print_max_width_cm", 137, "int", "Printing", "Printer media width (cm)", "Roland SG2-540: 137 cm."),

    # --- Seeds ----------------------------------------------------------
    Setting("ali_seed_category_ids", "", "text", "Seeds", "AliExpress category IDs for hot products (comma separated)",
            "Empty = all categories. Example: 15 (Home & Garden), 13 (Home Improvement)."),
    Setting("hot_product_pages", 2, "int", "Seeds", "Pages of AliExpress hot products per run (50 per page)"),

    # --- AI ---------------------------------------------------------------
    Setting("ai_daily_cost_cap_usd", 0.50, "float", "AI", "Daily AI spending cap (USD)",
            "When reached, the engine continues with the rule-based fallback."),
    Setting("ai_price_input_per_mtok", 0.10, "float", "AI", "AI price per million input tokens (USD)"),
    Setting("ai_price_output_per_mtok", 0.50, "float", "AI", "AI price per million output tokens (USD)"),
    Setting("ai_use_images", True, "bool", "AI", "Let AI compare product photos when matching (live mode)"),
    Setting("ai_explanations_top_n", 15, "int", "AI", "Write AI score explanations for the top N"),
]

SCHEMA_BY_KEY = {s.key: s for s in SCHEMA}


def defaults() -> dict[str, Any]:
    return {s.key: s.default for s in SCHEMA}


def coerce(setting: Setting, value: Any) -> Any:
    """Convert a value from the UI/DB to the setting's type; raise ValueError if invalid."""
    t = setting.type
    if t == "float":
        v = float(value)
        if v < 0:
            raise ValueError(f"{setting.label}: must be 0 or more")
        return v
    if t == "int":
        v = int(float(value))
        if v < 0:
            raise ValueError(f"{setting.label}: must be 0 or more")
        return v
    if t == "bool":
        if isinstance(value, bool):
            return value
        return str(value).strip().lower() in {"1", "true", "yes", "on"}
    if t == "choice":
        v = str(value)
        if v not in setting.choices:
            raise ValueError(f"{setting.label}: choose one of {', '.join(setting.choices)}")
        return v
    if t == "json":
        v = json.loads(value) if isinstance(value, str) else value
        if setting.key == "bol_fixed_fee_tiers":
            if not isinstance(v, list) or not v:
                raise ValueError("Fixed fee tiers must be a list like [[10, 0.2], [null, 0.99]]")
            for row in v:
                if not (isinstance(row, list) and len(row) == 2):
                    raise ValueError("Each fee tier must be [max price, fee]")
        return v
    return "" if value is None else str(value)


def get_settings(conn: sqlite3.Connection) -> dict[str, Any]:
    values = defaults()
    for row in conn.execute("SELECT key, value FROM settings"):
        key = row["key"]
        if key in SCHEMA_BY_KEY:
            try:
                values[key] = coerce(SCHEMA_BY_KEY[key], json.loads(row["value"]))
            except (ValueError, TypeError, json.JSONDecodeError):
                pass  # bad stored value: keep default
        else:
            # internal values (e.g. demo anchor date, learned weights)
            try:
                values[key] = json.loads(row["value"])
            except json.JSONDecodeError:
                values[key] = row["value"]
    return values


def save_settings(conn: sqlite3.Connection, changes: dict[str, Any]) -> dict[str, Any]:
    errors: list[str] = []
    clean: dict[str, Any] = {}
    for key, value in changes.items():
        setting = SCHEMA_BY_KEY.get(key)
        if setting is None:
            errors.append(f"Unknown setting: {key}")
            continue
        try:
            clean[key] = coerce(setting, value)
        except (ValueError, TypeError, json.JSONDecodeError) as exc:
            errors.append(str(exc) or f"Invalid value for {setting.label}")
    if errors:
        raise ValueError("; ".join(errors))
    for key, value in clean.items():
        set_internal(conn, key, value)
    return clean


def set_internal(conn: sqlite3.Connection, key: str, value: Any) -> None:
    conn.execute(
        "INSERT INTO settings(key, value) VALUES(?, ?) "
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        (key, json.dumps(value)),
    )
    conn.commit()


def reset_setting(conn: sqlite3.Connection, key: str) -> None:
    conn.execute("DELETE FROM settings WHERE key = ?", (key,))
    conn.commit()
