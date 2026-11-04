"""End-to-end tests of the daily run in demo mode (simulated APIs)."""
from datetime import date

import pytest

from app.clients.aliexpress import AliExpressClient
from app.clients.http import CredentialError
from app.config import get_env
from app.db import connect, loads
from app.mock.transport import MockTransport
from app.mock.world import DemoWorld
from app.pipeline.runner import run_daily
from app.web import main as web


def db():
    return connect(get_env().db_path)


def opps(conn, filtered=0, run_date="2026-11-04"):
    return [dict(r) for r in conn.execute(
        "SELECT * FROM opportunities WHERE filtered = ? AND run_date = ? ORDER BY score DESC", (filtered, run_date))]


def test_demo_run_finds_good_opportunities_and_drops_bad_ones():
    run_id = run_daily("test")
    conn = db()
    run = conn.execute("SELECT * FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert run["status"] == "ok", loads(run["summary_json"])
    good = opps(conn)
    names = {o["keyword"] for o in good}
    assert len(good) >= 6
    assert {"kruidenrek", "maanfasen muursticker", "raamfolie"} <= names
    for o in good:
        assert o["profit_eur"] >= 3.0
        assert o["match_confidence"] >= 0.5
        assert loads(o["risk_json"])["flags"] == []
        assert o["explanation"] and "per unit" in o["explanation"]
    # risky products never reach the list
    bad = {o["keyword"] for o in opps(conn, filtered=1)}
    for risky in ["nachtlampje", "speeltent", "gezichtsserum", "telefoonhoesje", "oversized hoodie",
                  "ronde wandspiegel", "zitzak"]:
        assert risky not in names
        assert risky in bad
    # seasonal and past-peak keywords are not considered rising
    for term in ["kerst raamstickers", "laptopstandaard", "deurstopper"]:
        k = conn.execute("SELECT last_signal_json FROM keywords WHERE term = ?", (term,)).fetchone()
        assert k is not None and not loads(k[0])["is_rising"], term
    # printable flag
    printable = {o["keyword"] for o in good if o["printable"]}
    assert "maanfasen muursticker" in printable and "kruidenrek" not in printable
    # keywords that point to the same AliExpress product are merged
    assert len({o["ali_product_id"] for o in good}) == len(good)
    # own history stored from day one
    assert conn.execute("SELECT COUNT(*) FROM product_ranks").fetchone()[0] > 100
    assert conn.execute("SELECT COUNT(*) FROM product_snapshots").fetchone()[0] > 20


def test_market_evolves_over_days_and_history_accumulates(monkeypatch):
    for day in ["2026-11-04", "2026-11-05", "2026-11-11", "2026-11-25"]:
        monkeypatch.setenv("DEMO_TODAY", day)
        run_daily("test")
    conn = db()
    days = conn.execute("SELECT COUNT(DISTINCT date) FROM product_snapshots").fetchone()[0]
    assert days == 4
    # the hanging planter trend starts later than the others and shows up eventually
    first = {o["keyword"] for o in opps(conn, run_date="2026-11-04")}
    later = {o["keyword"] for o in opps(conn, run_date="2026-11-25")}
    assert "hangende plantenbak" not in first
    assert "hangende plantenbak" in later
    # competition grows for emerging products
    ean = conn.execute("SELECT ean FROM opportunities WHERE keyword = 'kruidenrek' LIMIT 1").fetchone()[0]
    offers = [r[0] for r in conn.execute("SELECT offers_count FROM product_snapshots WHERE ean = ? ORDER BY date", (ean,))]
    assert offers[-1] > offers[0]


def test_decisions_are_remembered_and_learned(monkeypatch):
    run_daily("test")
    conn = db()
    good = opps(conn)
    by_kw = {o["keyword"]: o for o in good}
    web.decide(by_kw["kruidenrek"]["id"], web.Decision(decision="approved", reason="great margin"))
    for kw in ["maanfasen muursticker", "abstracte poster"]:
        web.decide(by_kw[kw]["id"], web.Decision(decision="rejected", reason="margin too low, lots of competition"))
    web.decide(by_kw["raamfolie"]["id"], web.Decision(decision="rejected", reason=""))
    summary = web.get_settings_api()["learning"]
    assert summary["active"] and summary["decisions"] == 4
    assert summary["multipliers"]["profit"] > 1 and summary["multipliers"]["competition"] > 1

    monkeypatch.setenv("DEMO_TODAY", "2026-11-05")
    run_daily("test")
    conn = db()
    day2 = {o["keyword"]: o for o in opps(conn, run_date="2026-11-05")}
    # rejected stays hidden, approved stays approved
    assert day2["maanfasen muursticker"]["status"] == "rejected"
    assert day2["kruidenrek"]["status"] == "approved"
    new_list = web.list_opportunities(date="2026-11-05", status="new")["items"]
    assert "maanfasen muursticker" not in {o["keyword"] for o in new_list}
    # learning changed scores: printable items (both rejected printables) move down
    assert any(o["learning_adj"] for o in day2.values())
    assert day2["huisdierhaar roller"]["status"] == "new"


def test_undo_decision():
    run_daily("test")
    o = opps(db())[0]
    web.decide(o["id"], web.Decision(decision="rejected", reason="x"))
    web.decide(o["id"], web.Decision(decision="new"))
    conn = db()
    assert conn.execute("SELECT status FROM opportunities WHERE id = ?", (o["id"],)).fetchone()[0] == "new"
    assert conn.execute("SELECT COUNT(*) FROM decisions").fetchone()[0] == 0


def test_rate_limits_are_retried(monkeypatch):
    monkeypatch.setenv("DEMO_SIMULATE_ERRORS", "true")
    run_id = run_daily("test")
    conn = db()
    run = conn.execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert run["status"] == "ok"
    warnings = conn.execute("SELECT COUNT(*) FROM run_log WHERE message LIKE '%rate limited%'").fetchone()[0]
    assert warnings > 5
    assert len(opps(conn)) >= 6


def test_live_mode_without_credentials_fails_clearly(monkeypatch):
    monkeypatch.setenv("ENGINE_MODE", "live")
    run_id = run_daily("test")
    conn = db()
    run = conn.execute("SELECT status, summary_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    assert run["status"] == "failed"
    msg = loads(run["summary_json"])["errors"][0]
    assert "BOL_CLIENT_ID" in msg and "ALIEXPRESS_APP_KEY" in msg and "ENGINE_MODE=demo" in msg


def test_live_mode_with_mock_sources_needs_no_keys(monkeypatch):
    monkeypatch.setenv("ENGINE_MODE", "live")
    monkeypatch.setenv("MOCK_SOURCES", "bol_retailer,bol_catalog,aliexpress")
    run_id = run_daily("test")
    assert db().execute("SELECT status FROM runs WHERE id = ?", (run_id,)).fetchone()[0] == "ok"


def test_wrong_aliexpress_secret_gives_credential_error():
    world = DemoWorld(date(2026, 11, 4), date(2026, 11, 4))
    client = AliExpressClient(MockTransport(world, ali_secret="real-secret"), "key", "wrong-secret")
    with pytest.raises(CredentialError) as exc:
        client.hot_products()
    assert "ALIEXPRESS_APP_SECRET" in exc.value.user_text()


def test_settings_validation():
    with pytest.raises(Exception):
        web.put_settings({"fulfilment_method": "DHL"})
    web.put_settings({"bol_commission_pct": "0.12", "fulfilment_method": "FBR"})
    values = {s["key"]: s["value"] for s in web.get_settings_api()["schema"]}
    assert values["bol_commission_pct"] == 0.12 and values["fulfilment_method"] == "FBR"


def test_api_payload_for_dashboard():
    run_daily("test")
    data = web.list_opportunities()
    o = data["items"][0]
    assert o["chart"]["labels"] and len(o["chart"]["this_year"]) == 52
    assert any(v is not None for v in o["chart"]["last_year"])
    assert o["ali"]["image_url"] and o["ali"]["url"]
    assert o["competitors"][0]["rank"] is not None
    assert data["filtered"]
    hist = web.history_keyword(o["keyword_id"])
    assert len(hist["series"]["values"]) >= 104 and hist["products"]
