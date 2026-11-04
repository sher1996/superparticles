"""Anthropic API helper with a hard daily cost cap and a result cache.

Every AI step in the engine has a rule-based fallback, so when there is no key,
the cap is reached, or the API fails, `complete_json` returns None and the
caller simply uses its rules.
"""
from __future__ import annotations

import hashlib
import json
import re
import sqlite3
from datetime import datetime
from typing import Any, Callable

try:
    import anthropic
except ImportError:  # the engine still works without the package
    anthropic = None  # type: ignore


class AIClient:
    def __init__(self, conn: sqlite3.Connection, api_key: str, model: str, settings: dict[str, Any],
                 today: str, log: Callable[[str, str], None] | None = None):
        self.conn = conn
        self.model = model
        self.settings = settings
        self.today = today
        self.log = log or (lambda level, msg: None)
        self.disabled_reason: str | None = None
        self._client = None
        self._cap_logged = False
        if not api_key:
            self.disabled_reason = "no ANTHROPIC_API_KEY set"
        elif anthropic is None:
            self.disabled_reason = "the 'anthropic' package is not installed"
        else:
            self._client = anthropic.Anthropic(api_key=api_key, max_retries=2, timeout=60)

    # -- budget -------------------------------------------------------------
    @property
    def cap(self) -> float:
        return float(self.settings.get("ai_daily_cost_cap_usd", 0.5))

    def spent_today(self) -> float:
        row = self.conn.execute("SELECT cost_usd FROM ai_usage WHERE date = ?", (self.today,)).fetchone()
        return float(row["cost_usd"]) if row else 0.0

    def _cost(self, input_tokens: int, output_tokens: int) -> float:
        return (input_tokens * float(self.settings.get("ai_price_input_per_mtok", 0.10))
                + output_tokens * float(self.settings.get("ai_price_output_per_mtok", 0.50))) / 1_000_000

    def _record(self, input_tokens: int, output_tokens: int) -> None:
        cost = self._cost(input_tokens, output_tokens)
        self.conn.execute(
            "INSERT INTO ai_usage(date, calls, input_tokens, output_tokens, cost_usd) VALUES(?,1,?,?,?) "
            "ON CONFLICT(date) DO UPDATE SET calls = calls + 1, input_tokens = input_tokens + excluded.input_tokens, "
            "output_tokens = output_tokens + excluded.output_tokens, cost_usd = cost_usd + excluded.cost_usd",
            (self.today, input_tokens, output_tokens, cost),
        )
        self.conn.commit()

    @property
    def available(self) -> bool:
        return self._client is not None and self.disabled_reason is None

    def status(self) -> str:
        if self.disabled_reason:
            return f"off ({self.disabled_reason}) - using rule-based fallback"
        return f"on ({self.model}), spent ${self.spent_today():.4f} of ${self.cap:.2f} today"

    # -- calls ----------------------------------------------------------------
    def complete_json(self, task: str, system: str, text: str, images: list[str] | None = None,
                      max_tokens: int = 500) -> Any | None:
        """Ask for a JSON answer. Returns parsed JSON, or None (caller falls back)."""
        if not self.available:
            return None
        images = [u for u in (images or []) if u.startswith("http")][:6]
        key = hashlib.sha256(json.dumps([self.model, task, system, text, images]).encode()).hexdigest()
        cached = self.conn.execute("SELECT value FROM ai_cache WHERE key = ?", (key,)).fetchone()
        if cached:
            try:
                return json.loads(cached["value"])
            except json.JSONDecodeError:
                pass

        est_in = int((len(system) + len(text)) / 3.5) + 1600 * len(images)
        if self.spent_today() + self._cost(est_in, max_tokens) > self.cap:
            if not self._cap_logged:
                self.log("warning", f"AI daily cost cap (${self.cap:.2f}) reached - "
                                    "continuing with rule-based fallback for the rest of today.")
                self._cap_logged = True
            return None

        content: list[dict[str, Any]] = [
            {"type": "image", "source": {"type": "url", "url": u}} for u in images
        ]
        content.append({"type": "text", "text": text})
        try:
            resp = self._client.messages.create(
                model=self.model,
                max_tokens=max_tokens,
                system=system,
                messages=[{"role": "user", "content": content}],
                thinking={"type": "disabled"},
                output_config={"effort": "low"},
            )
        except Exception as exc:  # noqa: BLE001 - classify below, never crash the run
            self._handle_error(exc, task)
            return None

        usage = getattr(resp, "usage", None)
        self._record(int(getattr(usage, "input_tokens", 0) or 0), int(getattr(usage, "output_tokens", 0) or 0))
        if getattr(resp, "stop_reason", None) == "refusal":
            return None
        out = "".join(getattr(b, "text", "") for b in resp.content if getattr(b, "type", "") == "text")
        parsed = _parse_json(out)
        if parsed is None:
            self.log("warning", f"AI ({task}) returned no valid JSON; using fallback for this item.")
            return None
        self.conn.execute("INSERT OR REPLACE INTO ai_cache(key, value, created_at) VALUES(?,?,?)",
                          (key, json.dumps(parsed), datetime.now().isoformat(timespec="seconds")))
        self.conn.commit()
        return parsed

    def _handle_error(self, exc: Exception, task: str) -> None:
        if anthropic is not None and isinstance(exc, anthropic.AuthenticationError):
            self.disabled_reason = "the Anthropic API key was rejected"
            self.log("error", "Anthropic API key rejected (401). Check ANTHROPIC_API_KEY in .env. "
                              "AI is off for this run; using rule-based fallback.")
        elif anthropic is not None and isinstance(exc, anthropic.PermissionDeniedError):
            self.disabled_reason = "the Anthropic API key has no access to this model"
            self.log("error", f"Anthropic API: no access to model '{self.model}'. Check AI_MODEL in .env.")
        elif anthropic is not None and isinstance(exc, anthropic.NotFoundError):
            self.disabled_reason = f"model '{self.model}' not found"
            self.log("error", f"Anthropic API: model '{self.model}' not found. Check AI_MODEL in .env.")
        elif anthropic is not None and isinstance(exc, anthropic.RateLimitError):
            self.log("warning", f"Anthropic API rate limit during {task}; using fallback for this item.")
        elif anthropic is not None and isinstance(exc, anthropic.BadRequestError):
            msg = str(exc)
            if "credit" in msg.lower() or "billing" in msg.lower():
                self.disabled_reason = "the Anthropic account has no credit"
                self.log("error", "Anthropic API: account has no credit left. AI is off for this run.")
            else:
                self.log("warning", f"Anthropic API rejected a {task} request: {msg[:200]}")
        elif anthropic is not None and isinstance(exc, anthropic.APIConnectionError):
            self.log("warning", f"Could not reach the Anthropic API during {task}; using fallback.")
        else:
            self.log("warning", f"AI {task} failed ({exc.__class__.__name__}); using fallback.")


def _parse_json(text: str) -> Any | None:
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", text, re.S)
    if fence:
        text = fence.group(1).strip()
    for candidate in (text, _first_bracketed(text)):
        if not candidate:
            continue
        try:
            return json.loads(candidate)
        except json.JSONDecodeError:
            continue
    return None


def _first_bracketed(text: str) -> str | None:
    starts = [i for i in (text.find("{"), text.find("[")) if i >= 0]
    if not starts:
        return None
    start = min(starts)
    end = max(text.rfind("}"), text.rfind("]"))
    return text[start:end + 1] if end > start else None
