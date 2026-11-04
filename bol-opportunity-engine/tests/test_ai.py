"""AI helper: cost cap, cache, and fallback when the API is unavailable."""
from types import SimpleNamespace

from app.clients.ai import AIClient
from app.config import get_env
from app.db import connect
from app.pipeline import matching
from app.pipeline.seeds import keywords_from_titles
from app.settings import defaults


class FakeMessages:
    def __init__(self, text):
        self.text = text
        self.calls = 0

    def create(self, **kwargs):
        self.calls += 1
        assert kwargs["model"] == "claude-haiku-5-5"
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=self.text)], stop_reason="end_turn",
                               usage=SimpleNamespace(input_tokens=100_000, output_tokens=20_000))


def make_ai(text, cap=0.5):
    conn = connect(get_env().db_path)
    s = defaults()
    s["ai_daily_cost_cap_usd"] = cap
    ai = AIClient(conn, "test-key", "claude-haiku-5-5", s, "2026-11-04")
    fake = FakeMessages(text)
    ai._client = SimpleNamespace(messages=fake)
    return ai, fake


def test_cost_cap_stops_ai_and_cache_avoids_repeat_calls():
    ai, fake = make_ai('{"ok": true}', cap=0.02)  # one call costs 0.01 + 0.01 = $0.02
    assert ai.complete_json("t", "sys", "a") == {"ok": True}
    assert ai.complete_json("t", "sys", "a") == {"ok": True}   # cached, no new call
    assert fake.calls == 1
    assert ai.complete_json("t", "sys", "b") is None           # would exceed the cap
    assert fake.calls == 1
    assert abs(ai.spent_today() - 0.02) < 1e-9


def test_ai_seed_keywords_used_and_rules_fill_gaps():
    ai, _ = make_ai('[{"i": 1, "nl": ["kruidenrek magnetisch"], "en": "magnetic spice rack"}]')
    kws = keywords_from_titles(["Magnetic Spice Rack", "Moon Phase Wall Sticker"], ai)
    terms = {k["nl"]: k["via"] for k in kws}
    assert terms["kruidenrek magnetisch"] == "ai"
    assert terms["maanfasen muursticker"] == "rules"


def test_ai_match_blends_with_rules():
    # candidates are shown to the AI ranked by rule score, so "1" is the magnetic one
    ai, _ = make_ai('{"best": 1, "confidence": 0.9, "reason": "same shape and size"}')
    ref = {"title": "Magnetisch kruidenrek - koelkast", "price": 30.0}
    cands = [{"title": "Wooden Spice Rack", "price": 5.0, "volume": 10},
             {"title": "Magnetic Spice Rack Fridge", "price": 4.0, "volume": 900}]
    res = matching.best_match("spice rack", ref, cands, ai=ai)
    assert res["source"] == "ai" and res["product"]["title"] == "Magnetic Spice Rack Fridge"
    assert res["confidence"] > 0.6


def test_no_key_means_rule_based():
    conn = connect(get_env().db_path)
    ai = AIClient(conn, "", "claude-haiku-5-5", defaults(), "2026-11-04")
    assert not ai.available and ai.complete_json("t", "s", "x") is None
    assert "fallback" in ai.status()
