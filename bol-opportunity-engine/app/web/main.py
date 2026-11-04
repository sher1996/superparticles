"""Local dashboard + JSON API (FastAPI). Start with `python run.py`."""
from __future__ import annotations

import html
from contextlib import asynccontextmanager
from datetime import datetime
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .. import scheduler
from ..config import ENV_FILE, get_env
from ..db import connect, dumps, loads, rows
from ..mock.world import unit
from ..pipeline.demand import last_year_overlay
from ..pipeline.learning import Learner
from ..pipeline.runner import check_connections, engine_today
from ..settings import SCHEMA, get_settings, reset_setting, save_settings

STATIC = Path(__file__).parent / "static"


def db():
    return connect(get_env().db_path)


@asynccontextmanager
async def lifespan(app: FastAPI):
    conn = db()
    conn.execute("UPDATE runs SET status = 'failed', finished_at = ?, summary_json = ? WHERE status = 'running'",
                 (datetime.now().isoformat(timespec="seconds"),
                  dumps({"errors": ["Run was interrupted (the app was closed while it ran)."]})))
    conn.commit()
    conn.close()
    scheduler.start()
    yield
    scheduler.stop()


app = FastAPI(title="bol Opportunity Engine", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=STATIC), name="static")


@app.get("/", include_in_schema=False)
def page_index():
    return FileResponse(STATIC / "index.html")


@app.get("/history", include_in_schema=False)
def page_history():
    return FileResponse(STATIC / "history.html")


@app.get("/settings", include_in_schema=False)
def page_settings():
    return FileResponse(STATIC / "settings.html")


# ---------------------------------------------------------------------------
@app.get("/api/status")
def status() -> dict[str, Any]:
    env = get_env()
    conn = db()
    settings = get_settings(conn)
    last = conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    today = engine_today(env).isoformat()
    usage = conn.execute("SELECT * FROM ai_usage WHERE date = ?", (today,)).fetchone()
    latest_date = conn.execute("SELECT MAX(run_date) FROM opportunities").fetchone()[0]
    out = {
        "mode": env.mode,
        "env_file_found": ENV_FILE.exists(),
        "today": today,
        "latest_date": latest_date,
        "simulated_sources": sorted(s for s in ("bol_retailer", "bol_catalog", "aliexpress") if env.uses_mock(s)),
        "credentials": {
            "bol_seller": env.has_bol_retailer_credentials(),
            "bol_affiliate": env.has_bol_catalog_credentials(),
            "aliexpress": env.has_ali_credentials(),
            "anthropic": env.has_ai(),
        },
        "missing_for_live": env.missing_live_credentials() if env.is_live else [],
        "ai_model": env.ai_model,
        "ai_today": dict(usage) if usage else {"calls": 0, "cost_usd": 0.0},
        "ai_cap": settings["ai_daily_cost_cap_usd"],
        "last_run": _run_row(last) if last else None,
        "next_run": scheduler.next_run_time(),
        "schedule": f"{env.daily_run_time} ({env.timezone})" if env.scheduler_enabled else "off",
        "keywords": conn.execute("SELECT COUNT(*) FROM keywords").fetchone()[0],
        "tracked_products": conn.execute("SELECT COUNT(*) FROM bol_products").fetchone()[0],
    }
    conn.close()
    return out


def _run_row(r) -> dict[str, Any]:
    d = dict(r)
    d["summary"] = loads(d.pop("summary_json"), {})
    return d


def _opportunity(conn, r, full: bool = True) -> dict[str, Any]:
    d = dict(r)
    for key in ("filter_reasons", "parts", "profit", "risk", "print", "competitors", "demand", "also_keywords",
                "features"):
        d[key] = loads(d.pop(f"{key}_json", None), {} if key in ("parts", "profit", "risk", "print", "demand") else [])
    ali = conn.execute("SELECT * FROM ali_products WHERE product_id = ?", (d.get("ali_product_id"),)).fetchone()
    d["ali"] = None
    if ali:
        a = dict(ali)
        a.pop("raw_json", None)
        d["ali"] = a
    if full:
        periods = [(x["year"], x["week"], x["total"]) for x in conn.execute(
            "SELECT year, week, total FROM search_volume WHERE keyword_id = ?", (d["keyword_id"],))]
        d["chart"] = last_year_overlay(periods, 52)
        eans = [c["ean"] for c in d["competitors"]]
        hist = {}
        for ean in eans:
            hist[ean] = rows(conn.execute(
                "SELECT date, price, offers_count, review_count FROM product_snapshots WHERE ean = ? "
                "ORDER BY date DESC LIMIT 30", (ean,)))[::-1]
            ranks = rows(conn.execute(
                "SELECT date, MIN(rank) AS rank, SUM(impressions) AS impressions FROM product_ranks WHERE ean = ? "
                "AND sponsored = 0 GROUP BY date ORDER BY date DESC LIMIT 30", (ean,)))[::-1]
            for c in d["competitors"]:
                if c["ean"] == ean:
                    c["history"] = hist[ean]
                    c["ranks"] = ranks
                    last = ranks[-1] if ranks else None
                    c["rank"] = last["rank"] if last else None
                    c["impressions"] = last["impressions"] if last else None
    return d


@app.get("/api/opportunities")
def list_opportunities(date: str | None = None, status: str = "new", printable: bool = False) -> dict[str, Any]:
    conn = db()
    run_date = date or conn.execute("SELECT MAX(run_date) FROM opportunities").fetchone()[0]
    if not run_date:
        conn.close()
        return {"date": None, "items": [], "filtered": [], "counts": {}}
    where = "run_date = ? AND filtered = 0"
    params: list[Any] = [run_date]
    if status != "all":
        where += " AND status = ?"
        params.append(status)
    if printable:
        where += " AND printable = 1"
    items = [_opportunity(conn, r) for r in conn.execute(
        f"SELECT * FROM opportunities WHERE {where} ORDER BY score DESC", params)]
    filtered = [{"id": r["id"], "keyword": r["keyword"], "score": r["score"],
                 "reasons": loads(r["filter_reasons_json"], [])}
                for r in conn.execute("SELECT id, keyword, score, filter_reasons_json FROM opportunities "
                                      "WHERE run_date = ? AND filtered = 1 ORDER BY score DESC", (run_date,))]
    counts = {r["status"]: r["n"] for r in conn.execute(
        "SELECT status, COUNT(*) AS n FROM opportunities WHERE run_date = ? AND filtered = 0 GROUP BY status",
        (run_date,))}
    dates = [r[0] for r in conn.execute("SELECT DISTINCT run_date FROM opportunities ORDER BY run_date DESC LIMIT 60")]
    conn.close()
    return {"date": run_date, "dates": dates, "items": items, "filtered": filtered, "counts": counts}


@app.get("/api/opportunities/{opp_id}")
def get_opportunity(opp_id: int) -> dict[str, Any]:
    conn = db()
    r = conn.execute("SELECT * FROM opportunities WHERE id = ?", (opp_id,)).fetchone()
    if not r:
        conn.close()
        raise HTTPException(404, "Opportunity not found")
    out = _opportunity(conn, r)
    conn.close()
    return out


class Decision(BaseModel):
    decision: str
    reason: str = ""


@app.post("/api/opportunities/{opp_id}/decision")
def decide(opp_id: int, body: Decision) -> dict[str, Any]:
    if body.decision not in ("approved", "rejected", "new"):
        raise HTTPException(400, "decision must be 'approved', 'rejected' or 'new' (undo)")
    conn = db()
    r = conn.execute("SELECT * FROM opportunities WHERE id = ?", (opp_id,)).fetchone()
    if not r:
        conn.close()
        raise HTTPException(404, "Opportunity not found")
    now = datetime.now().isoformat(timespec="seconds")
    reason = body.reason.strip()[:500]
    if body.decision == "new":
        conn.execute("UPDATE opportunities SET status = 'new', decision_reason = NULL, decided_at = NULL WHERE id = ?",
                     (opp_id,))
        conn.execute("DELETE FROM decisions WHERE opportunity_id = ?", (opp_id,))
    else:
        conn.execute("UPDATE opportunities SET status = ?, decision_reason = ?, decided_at = ? WHERE id = ?",
                     (body.decision, reason or None, now, opp_id))
        conn.execute("DELETE FROM decisions WHERE opportunity_id = ?", (opp_id,))
        conn.execute("INSERT INTO decisions(opportunity_id, keyword_id, ali_product_id, decision, reason, "
                     "features_json, score, created_at) VALUES(?,?,?,?,?,?,?,?)",
                     (opp_id, r["keyword_id"], r["ali_product_id"], body.decision, reason or None,
                      r["features_json"], r["score"], now))
    conn.commit()
    learner = Learner(conn, get_settings(conn)).summary()
    conn.close()
    return {"ok": True, "learning": learner}


# ---------------------------------------------------------------------------
@app.get("/api/history/keywords")
def history_keywords(q: str = "", only: str = "") -> dict[str, Any]:
    conn = db()
    where, params = "1=1", []
    if q:
        where += " AND k.term LIKE ?"
        params.append(f"%{q.lower()}%")
    if only == "opportunities":
        where += " AND EXISTS (SELECT 1 FROM opportunities o WHERE o.keyword_id = k.id AND o.filtered = 0)"
    if only == "rising":
        where += " AND json_extract(k.last_signal_json, '$.is_rising') = 1"
    items = []
    for k in conn.execute(f"SELECT k.* FROM keywords k WHERE {where} ORDER BY k.last_volume DESC NULLS LAST LIMIT 300",
                          params):
        spark = [r["total"] for r in conn.execute(
            "SELECT total FROM search_volume WHERE keyword_id = ? ORDER BY year DESC, week DESC LIMIT 26",
            (k["id"],))][::-1]
        sig = loads(k["last_signal_json"], {})
        best = conn.execute("SELECT MAX(score) AS s, MAX(status) AS st FROM opportunities WHERE keyword_id = ? "
                            "AND filtered = 0", (k["id"],)).fetchone()
        items.append({"id": k["id"], "term": k["term"], "source": k["source"], "status": k["status"],
                      "last_volume": k["last_volume"], "growth_4w": sig.get("growth_4w"), "yoy": sig.get("yoy"),
                      "is_rising": sig.get("is_rising"), "stage": sig.get("stage"),
                      "reasons": sig.get("reasons", []), "spark": spark, "best_score": best["s"],
                      "created_at": k["created_at"]})
    conn.close()
    return {"items": items}


@app.get("/api/history/keyword/{keyword_id}")
def history_keyword(keyword_id: int) -> dict[str, Any]:
    conn = db()
    k = conn.execute("SELECT * FROM keywords WHERE id = ?", (keyword_id,)).fetchone()
    if not k:
        conn.close()
        raise HTTPException(404, "Keyword not found")
    periods = [(x["year"], x["week"], x["total"]) for x in conn.execute(
        "SELECT year, week, total FROM search_volume WHERE keyword_id = ?", (keyword_id,))]
    full = sorted(periods)
    scores = rows(conn.execute(
        "SELECT run_date, score, profit_eur, filtered, status FROM opportunities WHERE keyword_id = ? ORDER BY run_date",
        (keyword_id,)))
    eans = [r["ean"] for r in conn.execute(
        "SELECT ean, MIN(position) AS pos FROM keyword_products WHERE keyword_id = ? GROUP BY ean ORDER BY pos LIMIT 8",
        (keyword_id,))]
    products = []
    for ean in eans:
        p = conn.execute("SELECT * FROM bol_products WHERE ean = ?", (ean,)).fetchone()
        products.append({
            "ean": ean, "title": p["title"] if p else "", "url": p["url"] if p else "",
            "snapshots": rows(conn.execute("SELECT * FROM product_snapshots WHERE ean = ? ORDER BY date", (ean,))),
            "ranks": rows(conn.execute(
                "SELECT date, MIN(rank) AS rank, SUM(impressions) AS impressions FROM product_ranks "
                "WHERE ean = ? AND sponsored = 0 GROUP BY date ORDER BY date", (ean,))),
        })
    out = {"keyword": dict(k) | {"signal": loads(k["last_signal_json"], {})},
           "series": {"labels": [f"{y}-W{w:02d}" for y, w, _ in full], "values": [v for *_, v in full]},
           "overlay": last_year_overlay(periods, 52), "scores": scores, "products": products}
    out["keyword"].pop("last_signal_json", None)
    conn.close()
    return out


# ---------------------------------------------------------------------------
@app.get("/api/settings")
def get_settings_api() -> dict[str, Any]:
    conn = db()
    values = get_settings(conn)
    learner = Learner(conn, values).summary()
    conn.close()
    return {"schema": [{"key": s.key, "type": s.type, "group": s.group, "label": s.label, "help": s.help,
                        "choices": list(s.choices), "default": s.default, "value": values[s.key]} for s in SCHEMA],
            "learning": learner}


@app.put("/api/settings")
def put_settings(changes: dict[str, Any]) -> dict[str, Any]:
    conn = db()
    try:
        saved = save_settings(conn, changes)
    except ValueError as exc:
        conn.close()
        raise HTTPException(400, str(exc)) from exc
    conn.close()
    return {"ok": True, "saved": saved}


@app.delete("/api/settings/{key}")
def delete_setting(key: str) -> dict[str, Any]:
    conn = db()
    reset_setting(conn, key)
    conn.close()
    return {"ok": True}


@app.post("/api/run")
def run_now() -> dict[str, Any]:
    if not scheduler.start_background_run("manual"):
        raise HTTPException(409, "A run is already in progress.")
    return {"ok": True}


@app.get("/api/runs")
def list_runs() -> dict[str, Any]:
    conn = db()
    out = [_run_row(r) for r in conn.execute("SELECT * FROM runs ORDER BY id DESC LIMIT 30")]
    conn.close()
    return {"items": out}


@app.get("/api/runs/{run_id}/log")
def run_log(run_id: int) -> dict[str, Any]:
    conn = db()
    out = rows(conn.execute("SELECT ts, level, step, message FROM run_log WHERE run_id = ? ORDER BY id", (run_id,)))
    conn.close()
    return {"items": out}


@app.post("/api/check-connections")
def api_check_connections() -> dict[str, Any]:
    return {"items": check_connections()}


# ---------------------------------------------------------------------------
@app.get("/demo-img/{kind}/{key}.svg", include_in_schema=False)
def demo_image(kind: str, key: str) -> Response:
    """Placeholder product photos for demo mode (no real images are fetched)."""
    hue = int(unit("img", key[:9]) * 360)
    hue2 = (hue + 40) % 360
    label = "AliExpress" if kind == "ali" else "bol"
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
<rect width="240" height="240" fill="hsl({hue},45%,88%)"/>
<rect x="50" y="60" width="140" height="110" rx="14" fill="hsl({hue},40%,62%)"/>
<circle cx="120" cy="115" r="30" fill="hsl({hue2},50%,80%)"/>
<text x="120" y="205" font-family="sans-serif" font-size="15" text-anchor="middle" fill="hsl({hue},30%,30%)">DEMO {html.escape(label)}</text>
</svg>"""
    return Response(svg, media_type="image/svg+xml", headers={"Cache-Control": "max-age=86400"})
