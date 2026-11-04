"""The daily run: seeds -> demand -> competition -> supply match -> profit ->
risk -> score -> save. Also tracks ranks/impressions/offers of every known EAN
daily, because bol only keeps ~3 months of that history.

Errors never crash silently: every step logs a plain-language message with a
hint (to logs/engine.log, and to the Runs page in the dashboard).
"""
from __future__ import annotations

import threading
import traceback
from datetime import date, datetime, timedelta
from typing import Any

from ..clients.ai import AIClient
from ..clients.aliexpress import AliExpressClient
from ..clients.bol import RETAILER_DEMO, RETAILER_LIVE, BolCatalogClient, BolRetailerClient
from ..clients.http import CredentialError, EngineError, RateLimitError, RequestsTransport
from ..config import Env, get_env
from ..db import connect, dumps, loads
from ..logs import setup_logging
from ..mock.transport import (DEMO_ALI_KEY, DEMO_ALI_SECRET, DEMO_BOL_ID, DEMO_BOL_SECRET,
                              MockTransport)
from ..mock.world import DemoWorld
from ..settings import get_settings, set_internal
from . import matching, printable, profit, risk, scoring
from .demand import analyse_series
from .learning import Learner, features
from .seeds import english_for, keywords_from_titles
from .text import parse_specs

RUN_LOCK = threading.Lock()


class RunAlreadyActive(Exception):
    pass


class Ctx:
    def __init__(self, conn, env: Env, settings: dict[str, Any], run_id: int, today: date):
        self.conn = conn
        self.env = env
        self.settings = settings
        self.run_id = run_id
        self.today = today
        self.step = "start"
        self.logger = setup_logging(env.log_dir)
        self.errors: list[str] = []
        self.warnings = 0
        self.summary: dict[str, Any] = {}

    def log(self, level: str, message: str, step: str | None = None) -> None:
        step = step or self.step
        self.conn.execute("INSERT INTO run_log(run_id, ts, level, step, message) VALUES(?,?,?,?,?)",
                          (self.run_id, datetime.now().isoformat(timespec="seconds"), level, step, message))
        self.conn.commit()
        getattr(self.logger, {"warning": "warning", "error": "error"}.get(level, "info"))(f"[{step}] {message}")
        if level == "error":
            self.errors.append(message)
        elif level == "warning":
            self.warnings += 1


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def engine_today(env: Env) -> date:
    if not env.is_live and env.demo_today:
        return date.fromisoformat(env.demo_today)
    return date.today()


def build_clients(conn, env: Env, settings: dict[str, Any], today: date, log):
    """Create the three API clients. Demo sources use the built-in simulator."""
    mock = None
    if any(env.uses_mock(s) for s in ("bol_retailer", "bol_catalog", "aliexpress")):
        anchor = settings.get("demo_anchor_date")
        if not anchor:
            anchor = today.isoformat()
            set_internal(conn, "demo_anchor_date", anchor)
        world = DemoWorld(date.fromisoformat(anchor), today)
        mock = MockTransport(world, simulate_errors=env.demo_simulate_errors,
                             ali_secret=env.ali_app_secret or DEMO_ALI_SECRET)
    live = RequestsTransport()
    if env.uses_mock("bol_retailer"):
        retailer = BolRetailerClient(mock, env.bol_client_id or DEMO_BOL_ID,
                                     env.bol_client_secret or DEMO_BOL_SECRET, RETAILER_DEMO, log)
    else:
        retailer = BolRetailerClient(live, env.bol_client_id, env.bol_client_secret, RETAILER_LIVE, log)
    if env.uses_mock("bol_catalog"):
        catalog = BolCatalogClient(mock, env.bol_affiliate_client_id or DEMO_BOL_ID,
                                   env.bol_affiliate_client_secret or DEMO_BOL_SECRET, log)
    else:
        catalog = BolCatalogClient(live, env.bol_affiliate_client_id, env.bol_affiliate_client_secret, log)
    if env.uses_mock("aliexpress"):
        ali = AliExpressClient(mock, env.ali_app_key or DEMO_ALI_KEY, env.ali_app_secret or DEMO_ALI_SECRET,
                               env.ali_tracking_id, log)
    else:
        ali = AliExpressClient(live, env.ali_app_key, env.ali_app_secret, env.ali_tracking_id, log)
    return retailer, catalog, ali


# ---------------------------------------------------------------------------
def run_daily(trigger: str = "manual", db_path: str | None = None) -> int:
    """Run the whole funnel once. Returns the run id."""
    if not RUN_LOCK.acquire(blocking=False):
        raise RunAlreadyActive("A run is already in progress.")
    try:
        env = get_env()
        conn = connect(db_path or env.db_path)
        today = engine_today(env)
        cur = conn.execute("INSERT INTO runs(started_at, run_date, mode, trigger, status) VALUES(?,?,?,?,?)",
                           (_now(), today.isoformat(), env.mode, trigger, "running"))
        conn.commit()
        run_id = cur.lastrowid
        settings = get_settings(conn)
        ctx = Ctx(conn, env, settings, run_id, today)
        status = "ok"
        try:
            _run(ctx)
            if ctx.errors:
                status = "partial"
        except CredentialError as exc:
            ctx.log("error", exc.user_text())
            status = "failed"
        except Exception as exc:  # noqa: BLE001 - always record the failure
            ctx.log("error", f"Unexpected error: {exc.__class__.__name__}: {exc}")
            ctx.logger.error(traceback.format_exc())
            status = "failed"
        ctx.summary["errors"] = ctx.errors
        ctx.summary["warnings"] = ctx.warnings
        conn.execute("UPDATE runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?",
                     (_now(), status, dumps(ctx.summary), run_id))
        conn.commit()
        ctx.log("info", f"Run finished with status '{status}'.", "done")
        conn.close()
        return run_id
    finally:
        RUN_LOCK.release()


def _run(ctx: Ctx) -> None:
    env, s = ctx.env, ctx.settings
    missing = env.missing_live_credentials()
    if missing:
        raise CredentialError("setup", "Live mode needs these .env values: " + ", ".join(missing) + ".",
                              "Fill them in (see README), or set ENGINE_MODE=demo, or list the source in "
                              "MOCK_SOURCES while your account is pending.")
    ctx.log("info", f"Starting {'LIVE' if env.is_live else 'DEMO'} run for {ctx.today.isoformat()}"
                    + (f" (simulated sources: {', '.join(sorted(env.mock_sources))})" if env.is_live and env.mock_sources else ""))
    ai = AIClient(ctx.conn, env.anthropic_api_key, env.ai_model, s, ctx.today.isoformat(),
                  lambda lvl, msg: ctx.log(lvl, msg))
    ctx.log("info", f"AI: {ai.status()}")
    retailer, catalog, ali = build_clients(ctx.conn, env, s, ctx.today, lambda lvl, msg: ctx.log(lvl, msg))

    ctx.step = "seeds"
    step_seeds(ctx, ali, ai)
    ctx.step = "demand"
    rising = step_demand(ctx, retailer)
    ctx.step = "opportunities"
    step_opportunities(ctx, rising, retailer, catalog, ali, ai)
    ctx.step = "tracking"
    step_tracking(ctx, retailer, catalog)
    ctx.summary["ai"] = ai.status()


# ---------------------------------------------------------------------------
def _add_keyword(ctx: Ctx, term: str, source: str, detail: str, english: str | None) -> bool:
    term = term.strip().lower()
    if not term or len(term) > 80:
        return False
    cur = ctx.conn.execute(
        "INSERT OR IGNORE INTO keywords(term, source, source_detail, english, created_at) VALUES(?,?,?,?,?)",
        (term, source, detail[:300], english, _now()))
    return cur.rowcount > 0


def _save_ali(ctx: Ctx, p: dict[str, Any]) -> None:
    ctx.conn.execute(
        "INSERT OR REPLACE INTO ali_products(product_id, title, image_url, url, price, original_price, currency, "
        "volume, rating, category, category2, shipping, delivery_days, fetched_at, raw_json) "
        "VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (p["product_id"], p["title"], p["image_url"], p["url"], p["price"], p["original_price"], p["currency"],
         p["volume"], p["rating"], p["category"], p["category2"], p["shipping"], p["delivery_days"], _now(),
         dumps(p)))


def step_seeds(ctx: Ctx, ali: AliExpressClient, ai: AIClient) -> None:
    s = ctx.settings
    products: list[dict[str, Any]] = []
    try:
        for page in range(1, int(s["hot_product_pages"]) + 1):
            batch = ali.hot_products(category_ids=str(s["ali_seed_category_ids"]).replace(" ", ""), page_no=page)
            products += batch
            if len(batch) < 50:
                break
    except EngineError as exc:
        ctx.log("error", "Could not get AliExpress hot products: " + exc.user_text()
                + " Continuing with existing keywords.")
        return
    for p in products:
        _save_ali(ctx, p)
    titles = [p["title"] for p in products]
    kws = keywords_from_titles(titles, ai)
    added = 0
    cap = int(s["max_new_keywords_per_run"])
    for kw in kws:
        if added >= cap:
            break
        if _add_keyword(ctx, kw["nl"], "aliexpress", kw["title"], kw["en"] or None):
            added += 1
    ctx.conn.commit()
    ctx.summary["hot_products"] = len(products)
    ctx.summary["seeds_added"] = added
    ctx.log("info", f"{len(products)} AliExpress hot products -> {len(kws)} keyword ideas, {added} new keywords.")


def step_demand(ctx: Ctx, retailer: BolRetailerClient) -> list[dict[str, Any]]:
    s = ctx.settings
    conn = ctx.conn
    week_ago = (ctx.today - timedelta(days=7)).isoformat()
    todays = ctx.today.isoformat()
    budget = int(s["max_keywords_per_run"])
    new_budget = int(s["max_new_keywords_per_run"])  # separate budget for bol related terms
    checked = 0
    related_added = 0
    limited = False
    for _pass in range(3):  # extra passes pick up related terms found in this run
        if limited or checked >= budget:
            break
        rows = conn.execute(
            "SELECT * FROM keywords WHERE (status = 'active' AND (last_checked IS NULL OR substr(last_checked,1,10) < ?)) "
            "OR (status = 'dormant' AND substr(last_checked,1,10) <= ?) "
            "ORDER BY last_checked IS NOT NULL, last_checked LIMIT ?",
            (todays, week_ago, budget - checked)).fetchall()
        if not rows:
            break
        ctx.log("info", f"Checking search volume for {len(rows)} keywords.")
        checked, related_added, limited = _demand_pass(ctx, retailer, rows, checked, related_added, new_budget)
    rising = conn.execute(
        "SELECT k.*, ks.signal_json AS sig FROM keyword_signals ks JOIN keywords k ON k.id = ks.keyword_id "
        "WHERE ks.run_date = ? AND ks.is_rising = 1 ORDER BY k.last_volume DESC", (todays,)).fetchall()
    ctx.summary.update(keywords_checked=checked, related_added=related_added, rising=len(rising),
                       keywords_total=conn.execute("SELECT COUNT(*) FROM keywords").fetchone()[0])
    ctx.log("info", f"{checked} keywords checked, {len(rising)} rising, {related_added} related terms added.")
    return [dict(r) for r in rising]


def _demand_pass(ctx: Ctx, retailer, rows, checked: int, related_added: int, new_budget: int):
    s = ctx.settings
    conn = ctx.conn
    todays = ctx.today.isoformat()
    for kw in rows:
        try:
            data = retailer.search_terms(kw["term"], periods=min(208, int(s["history_weeks"])), related=True)
        except RateLimitError as exc:
            ctx.log("error", exc.user_text() + f" Checked {checked} keywords before the limit.")
            return checked, related_added, True
        except CredentialError:
            raise
        except EngineError as exc:
            ctx.log("warning", f"Skipped '{kw['term']}': {exc.user_text()}")
            continue
        checked += 1
        for y, w, v in data["periods"]:
            conn.execute("INSERT OR REPLACE INTO search_volume(keyword_id, year, week, total, fetched_at) "
                         "VALUES(?,?,?,?,?)", (kw["id"], y, w, v, _now()))
        periods = [(r["year"], r["week"], r["total"]) for r in conn.execute(
            "SELECT year, week, total FROM search_volume WHERE keyword_id = ?", (kw["id"],))]
        sig = analyse_series(periods, s)
        flat = 0 if sig["is_rising"] else kw["flat_checks"] + 1
        status = "dormant" if flat >= int(s["dormant_after_checks"]) else "active"
        stamp = f"{todays}T{datetime.now().strftime('%H:%M:%S')}"  # engine date (demo date can be pinned)
        conn.execute("UPDATE keywords SET last_checked = ?, last_volume = ?, last_signal_json = ?, flat_checks = ?, "
                     "status = ? WHERE id = ?", (stamp, int(sig.get("avg_weekly") or 0), dumps(sig), flat,
                                                 status, kw["id"]))
        conn.execute("INSERT OR REPLACE INTO keyword_signals(keyword_id, run_date, is_rising, signal_json) "
                     "VALUES(?,?,?,?)", (kw["id"], todays, int(sig["is_rising"]), dumps(sig)))
        for term, total in data["related"]:
            if related_added >= new_budget:
                break
            if total >= int(s["min_weekly_volume"]) and _add_keyword(ctx, term, "bol_related", kw["term"], None):
                related_added += 1
        conn.commit()
    return checked, related_added, False


# ---------------------------------------------------------------------------
class _Flags:
    catalog_ok = True
    ali_ok = True


def _snapshot_product(ctx: Ctx, retailer, catalog, flags: _Flags, ean: str, title_hint: str,
                      with_ranks: bool = True) -> dict[str, Any]:
    """Fetch price/offers/reviews (+ranks) for one EAN and store today's snapshot."""
    conn, todays = ctx.conn, ctx.today.isoformat()
    info: dict[str, Any] = {"ean": ean, "title": title_hint}
    if flags.catalog_ok:
        try:
            cat = catalog.product(ean)
            if cat:
                info.update({k: v for k, v in cat.items() if v not in (None, "")})
        except CredentialError as exc:
            flags.catalog_ok = False
            ctx.log("error", exc.user_text() + " Continuing without catalog data (prices from offers).")
        except EngineError as exc:
            ctx.log("warning", f"Catalog data for {ean} skipped: {exc.user_text()}")
    offers = retailer.competing_offers(ean)
    ratings = retailer.ratings(ean)
    prices = [o["price"] for o in offers if o.get("price")]
    if not info.get("price") and prices:
        info["price"] = min(prices)
    info["offers"] = len(offers)
    info["fbb_offers"] = sum(1 for o in offers if o.get("fulfilment") == "FBB")
    info["reviews"] = ratings["count"]
    info["rating"] = info.get("rating") or ratings["average"]
    title = info.get("title") or ""
    info["weak_listing"] = len(title) < 40 or not info.get("image_url") or ratings["count"] < 3
    conn.execute("INSERT OR REPLACE INTO product_snapshots(ean, date, price, offers_count, fbb_offers, "
                 "review_count, rating, delivery) VALUES(?,?,?,?,?,?,?,?)",
                 (ean, todays, info.get("price"), info["offers"], info["fbb_offers"], info["reviews"],
                  info.get("rating"), info.get("delivery")))
    existing = conn.execute("SELECT backfilled FROM bol_products WHERE ean = ?", (ean,)).fetchone()
    conn.execute(
        "INSERT INTO bol_products(ean, title, url, image_url, first_seen, last_seen) VALUES(?,?,?,?,?,?) "
        "ON CONFLICT(ean) DO UPDATE SET title = excluded.title, url = COALESCE(NULLIF(excluded.url,''), url), "
        "image_url = COALESCE(NULLIF(excluded.image_url,''), image_url), last_seen = excluded.last_seen",
        (ean, title, info.get("url") or "", info.get("image_url") or "", todays, todays))
    if with_ranks:
        _store_ranks(ctx, retailer, ean, ctx.today - timedelta(days=1))
        if not existing or not existing["backfilled"]:
            for wk in range(1, min(12, int(ctx.settings["rank_backfill_weeks"])) + 1):
                _store_ranks(ctx, retailer, ean, ctx.today - timedelta(days=1 + 7 * wk))
            conn.execute("UPDATE bol_products SET backfilled = 1 WHERE ean = ?", (ean,))
    conn.commit()
    return info


def _store_ranks(ctx: Ctx, retailer, ean: str, on: date) -> None:
    for r in retailer.product_ranks(ean, on):
        ctx.conn.execute("INSERT OR REPLACE INTO product_ranks(ean, date, search_term, rank, impressions, sponsored) "
                         "VALUES(?,?,?,?,?,?)", (ean, on.isoformat(), r["search_term"], r["rank"],
                                                 r["impressions"], int(r["sponsored"])))


def step_opportunities(ctx: Ctx, rising: list[dict[str, Any]], retailer, catalog, ali, ai) -> None:
    s = ctx.settings
    conn = ctx.conn
    learner = Learner(conn, s)
    flags = _Flags()
    built: list[dict[str, Any]] = []
    for kw in rising:
        if not flags.ali_ok:
            break
        sig = loads(kw["sig"], {})
        try:
            opp = _build_one(ctx, kw, sig, retailer, catalog, ali, ai, flags, learner)
        except CredentialError as exc:
            if exc.source.startswith("AliExpress"):
                flags.ali_ok = False
                ctx.log("error", exc.user_text() + " Cannot match products without AliExpress; stopping this step.")
                break
            raise
        except RateLimitError as exc:
            ctx.log("error", exc.user_text() + " Stopping the competition step for today.")
            break
        except EngineError as exc:
            ctx.log("warning", f"Skipped '{kw['term']}': {exc.user_text()}")
            continue
        if opp:
            built.append(opp)

    # one opportunity per AliExpress product: merge keywords that point to the same product
    built.sort(key=lambda o: (o["filtered"], -(o["score"] or 0)))
    best_for_product: dict[str, dict[str, Any]] = {}
    for o in built:
        pid = o.get("ali_product_id")
        if not pid or o["filtered"]:
            continue
        if pid in best_for_product:
            keeper = best_for_product[pid]
            keeper["also_keywords"].append(o["keyword"])
            o["filtered"] = 1
            o["filter_reasons"].append(f"same product as '{keeper['keyword']}'")
        else:
            best_for_product[pid] = o
    for o in best_for_product.values():
        if o["also_keywords"]:
            o["explanation"] = scoring.explain(o["keyword"], o["_sig"], o["_comp"], o["profit"], o["_match"],
                                               o["print"], o["_learning_note"], o["also_keywords"])

    # AI explanation for the top N (cost-capped); template stays as fallback
    top = sorted((o for o in built if not o["filtered"]), key=lambda o: -o["score"])
    for o in top[: int(s["ai_explanations_top_n"])]:
        text = scoring.ai_explain(ai, o["explanation"])
        if text:
            o["explanation"] = text + ((" " + o["_learning_note"]) if o["_learning_note"] and o["_learning_note"] not in text else "")
            o["explanation_source"] = "ai"

    for o in built:
        _carry_status(ctx, o)
        _save_opportunity(ctx, o)
    conn.commit()
    shown = sum(1 for o in built if not o["filtered"])
    reasons: dict[str, int] = {}
    for o in built:
        for r in o["filter_reasons"]:
            key = r.split(":")[0].split("(")[0].strip()
            reasons[key] = reasons.get(key, 0) + 1
    ctx.summary.update(opportunities=shown, filtered=len(built) - shown, filter_reasons=reasons,
                       learning=learner.summary()["multipliers"] if learner.active else "not active yet")
    ctx.log("info", f"{shown} opportunities, {len(built) - shown} filtered out.")


def _build_one(ctx: Ctx, kw, sig, retailer, catalog, ali, ai, flags: _Flags, learner: Learner):
    s = ctx.settings
    conn = ctx.conn
    todays = ctx.today.isoformat()
    products = retailer.product_list(kw["term"])[: int(s["top_products_per_keyword"])]
    if not products:
        ctx.log("warning", f"No bol products found for '{kw['term']}'.")
        return None
    competitors = []
    for pos, p in enumerate(products):
        conn.execute("INSERT OR REPLACE INTO keyword_products(keyword_id, ean, run_date, position) VALUES(?,?,?,?)",
                     (kw["id"], p["ean"], todays, pos))
        info = _snapshot_product(ctx, retailer, catalog, flags, p["ean"], p["title"])
        info["position"] = pos + 1
        competitors.append(info)
    comp = scoring.competition_summary(competitors)

    english = english_for(kw["term"], kw["english"], ai)
    if not kw["english"]:
        conn.execute("UPDATE keywords SET english = ? WHERE id = ?", (english, kw["id"]))
    candidates = ali.search_products(english, page_size=int(s["ali_candidates_per_keyword"]))
    for c in candidates:
        _save_ali(ctx, c)
    ref = next((c for c in competitors if c.get("price")), competitors[0])
    match = matching.best_match(english, ref, candidates, ai=ai, use_images=bool(s["ai_use_images"]),
                                compare_photos=ctx.env.is_live and not ctx.env.uses_mock("aliexpress"),
                                log=lambda lvl, msg: ctx.log(lvl, msg))

    o: dict[str, Any] = {
        "keyword_id": kw["id"], "keyword": kw["term"], "ean": ref["ean"], "filtered": 0, "filter_reasons": [],
        "also_keywords": [], "competitors": competitors, "competition": comp, "demand": sig,
        "explanation_source": "template", "_sig": sig, "_comp": comp, "_learning_note": "",
    }
    if not match:
        o.update(filtered=1, ali_product_id=None, score=0, base_score=0, learning_adj=0, parts={},
                 profit={}, risk={"flags": [], "notes": []}, print={"printable": False},
                 match_confidence=0, match_reason="no AliExpress results", match_source="rules",
                 explanation="No AliExpress products found for this keyword.", features=[], sale_price=None)
        o["filter_reasons"].append("no AliExpress product found")
        o["_match"] = {"confidence": 0}
        return o

    a = match["product"]
    sale_price = profit.choose_sale_price([c.get("price") for c in competitors], s) or ref.get("price") or 0
    dims = parse_specs(a["title"]).get("dims_cm")
    size = profit.size_class(a["title"] + " " + (ref.get("title") or ""), dims)
    pr = profit.calculate(sale_price, a["price"] or 0, a.get("shipping"), size, s)
    texts = [kw["term"], a["title"], a.get("category"), a.get("category2")] + [c.get("title") for c in competitors[:3]]
    ai_flags = risk.ai_check(ai, ref.get("title") or "", a["title"], a.get("category") or "")
    rk = risk.check(texts, s, ai_flags)
    pt = printable.check([kw["term"], a["title"], ref.get("title") or ""], s)

    parts = {
        "demand": scoring.demand_part(sig),
        "earliness": float(sig.get("earliness") or 0),
        "competition": comp["score"],
        "profit": scoring.profit_part(pr),
        "match": float(match["confidence"]),
    }
    base = scoring.combine(parts, s, learner.multipliers if learner.active else None)
    feat_input = {"keyword": kw["term"], "category": a.get("category"), "category2": a.get("category2"),
                  "sale_price": sale_price, "profit_eur": pr["profit"], "size": size,
                  "printable": pt.get("printable"), "competition_level": comp["level"], "stage": sig.get("stage")}
    feats = features(feat_input)
    adj, note = learner.adjustment(feats)
    score = round(max(0.0, min(100.0, base + adj)), 1)

    reasons = o["filter_reasons"]
    for f in rk["flags"]:
        reasons.append(f"risk: {f['label']} ('{f['evidence']}')")
    if match["confidence"] < float(s["min_match_confidence"]):
        reasons.append(f"match: AliExpress match too uncertain ({match['confidence']:.0%})")
    if pr["profit"] < float(s["min_profit_eur"]):
        reasons.append(f"profit: only EUR {pr['profit']:.2f} per unit")
    elif pr["margin"] < float(s["min_margin_pct"]):
        reasons.append(f"profit: margin only {pr['margin']:.0%}")
    o.update(
        filtered=1 if reasons else 0, ali_product_id=a["product_id"], ali=a, score=score, base_score=base,
        learning_adj=adj, parts=parts, profit=pr, risk=rk, print=pt, sale_price=sale_price,
        match_confidence=match["confidence"], match_reason=match["reason"], match_source=match["source"],
        features=feats, _match=match, _learning_note=note,
        explanation=scoring.explain(kw["term"], sig, comp, pr, match, pt, note),
    )
    return o


def _carry_status(ctx: Ctx, o: dict[str, Any]) -> None:
    """Keep your earlier decision: approved stays approved; rejected stays hidden
    unless enough days passed AND the score improved by 15+ points."""
    o["status"] = "new"
    o["decision_reason"] = None
    prev = ctx.conn.execute(
        "SELECT status, score, decided_at, decision_reason FROM opportunities "
        "WHERE (keyword_id = ? OR (ali_product_id IS NOT NULL AND ali_product_id = ?)) "
        "AND status != 'new' ORDER BY decided_at DESC LIMIT 1",
        (o["keyword_id"], o.get("ali_product_id"))).fetchone()
    if not prev:
        return
    if prev["status"] == "approved":
        o["status"] = "approved"
        o["decision_reason"] = prev["decision_reason"]
        return
    decided = date.fromisoformat((prev["decided_at"] or ctx.today.isoformat())[:10])
    days = (ctx.today - decided).days
    if days < int(ctx.settings["resuggest_rejected_after_days"]) or (o["score"] or 0) < (prev["score"] or 0) + 15:
        o["status"] = "rejected"
        o["decision_reason"] = prev["decision_reason"]


def _save_opportunity(ctx: Ctx, o: dict[str, Any]) -> None:
    conn = ctx.conn
    todays = ctx.today.isoformat()
    existing = conn.execute("SELECT id, status, decision_reason, decided_at FROM opportunities "
                            "WHERE run_date = ? AND keyword_id = ?", (todays, o["keyword_id"])).fetchone()
    status, reason, decided_at = o["status"], o["decision_reason"], None
    if existing and existing["status"] != "new":  # decided earlier today: keep it
        status, reason, decided_at = existing["status"], existing["decision_reason"], existing["decided_at"]
    competitors = [{k: c.get(k) for k in ("ean", "title", "price", "offers", "fbb_offers", "reviews", "rating",
                                          "url", "image_url", "delivery", "position", "weak_listing")}
                   for c in o["competitors"]]
    values = dict(
        run_date=todays, keyword_id=o["keyword_id"], keyword=o["keyword"], ean=o.get("ean"),
        ali_product_id=o.get("ali_product_id"), status=status, filtered=o["filtered"],
        filter_reasons_json=dumps(o["filter_reasons"]), score=o["score"], base_score=o["base_score"],
        learning_adj=o["learning_adj"], parts_json=dumps(o["parts"]), explanation=o["explanation"],
        explanation_source=o["explanation_source"], profit_json=dumps(o["profit"]),
        profit_eur=(o["profit"] or {}).get("profit"), margin=(o["profit"] or {}).get("margin"),
        sale_price=o.get("sale_price"), match_confidence=o["match_confidence"], match_reason=o["match_reason"],
        match_source=o["match_source"], risk_json=dumps(o["risk"]), printable=int(bool(o["print"].get("printable"))),
        print_json=dumps(o["print"]), competitors_json=dumps(competitors),
        demand_json=dumps({**o["demand"], "competition": o["competition"]}),
        also_keywords_json=dumps(o["also_keywords"]), features_json=dumps(o["features"]),
        decision_reason=reason, decided_at=decided_at, created_at=_now(),
    )
    if existing:
        sets = ", ".join(f"{k} = :{k}" for k in values)
        conn.execute(f"UPDATE opportunities SET {sets} WHERE id = :id", {**values, "id": existing["id"]})
    else:
        cols = ", ".join(values)
        conn.execute(f"INSERT INTO opportunities({cols}) VALUES({', '.join(':' + k for k in values)})", values)


def step_tracking(ctx: Ctx, retailer, catalog) -> None:
    """Daily snapshot of every tracked EAN we have not refreshed today."""
    todays = ctx.today.isoformat()
    cutoff = (ctx.today - timedelta(days=60)).isoformat()
    eans = [r["ean"] for r in ctx.conn.execute(
        "SELECT p.ean, p.title FROM bol_products p WHERE p.tracked = 1 AND p.last_seen >= ? "
        "AND NOT EXISTS (SELECT 1 FROM product_snapshots s WHERE s.ean = p.ean AND s.date = ?) "
        "ORDER BY p.last_seen DESC LIMIT ?", (cutoff, todays, int(ctx.settings["max_tracked_eans"])))]
    flags = _Flags()
    done = 0
    for ean in eans:
        title = ctx.conn.execute("SELECT title FROM bol_products WHERE ean = ?", (ean,)).fetchone()["title"]
        try:
            _snapshot_product(ctx, retailer, catalog, flags, ean, title or "")
            done += 1
        except RateLimitError as exc:
            ctx.log("error", exc.user_text() + f" Tracked {done} of {len(eans)} products.")
            break
        except CredentialError:
            raise
        except EngineError as exc:
            ctx.log("warning", f"Tracking {ean} skipped: {exc.user_text()}")
    ctx.summary["tracked_extra"] = done
    if eans:
        ctx.log("info", f"Tracked {done} more products (ranks, impressions, offers).")


def check_connections() -> list[dict[str, str]]:
    """Used by the Settings page: try each API and report in plain words."""
    env = get_env()
    conn = connect(env.db_path)
    settings = get_settings(conn)
    today = engine_today(env)
    retailer, catalog, ali = build_clients(conn, env, settings, today, None)
    out = []
    for name, source, client, has_creds in (
        ("bol Retailer API (seller)", "bol_retailer", retailer, env.has_bol_retailer_credentials()),
        ("bol Marketing Catalog API (affiliate)", "bol_catalog", catalog, env.has_bol_catalog_credentials()),
        ("AliExpress Affiliate API", "aliexpress", ali, env.has_ali_credentials()),
    ):
        mode = "simulated (demo)" if env.uses_mock(source) else "live"
        try:
            client.check_connection()
            out.append({"api": name, "mode": mode, "ok": True, "message": "Connected"})
        except EngineError as exc:
            out.append({"api": name, "mode": mode, "ok": False, "message": exc.user_text()})
        except Exception as exc:  # noqa: BLE001
            out.append({"api": name, "mode": mode, "ok": False, "message": f"{exc.__class__.__name__}: {exc}"})
        if env.uses_mock(source) and source == "bol_retailer" and has_creds:
            # demo mode with real seller credentials: also test bol's own demo environment
            sandbox = BolRetailerClient(RequestsTransport(), env.bol_client_id, env.bol_client_secret, RETAILER_DEMO)
            try:
                sandbox.check_connection()
                out.append({"api": "bol Retailer API demo environment", "mode": "bol sandbox", "ok": True,
                            "message": "Your seller credentials work against bol's demo environment."})
            except EngineError as exc:
                out.append({"api": "bol Retailer API demo environment", "mode": "bol sandbox", "ok": False,
                            "message": exc.user_text()})
    ai = AIClient(conn, env.anthropic_api_key, env.ai_model, settings, today.isoformat())
    if ai.available:
        res = ai.complete_json("ping", "Answer ONLY with JSON {\"ok\": true}.", "ping", max_tokens=20)
        out.append({"api": "Anthropic API (AI)", "mode": env.ai_model, "ok": bool(res),
                    "message": "Connected" if res else ai.status()})
    else:
        out.append({"api": "Anthropic API (AI)", "mode": "off", "ok": True, "message": ai.status()})
    conn.close()
    return out
