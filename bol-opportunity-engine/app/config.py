"""Environment configuration (.env) — credentials and infrastructure only.

Everything that is a business rule (fees, thresholds, weights) lives in
app/settings.py and can be edited from the dashboard. Credentials never live in
code: they are read from the .env file next to this project.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR / ".env"

load_dotenv(ENV_FILE, override=False)


def _bool(value: str | None, default: bool = False) -> bool:
    if value is None or value.strip() == "":
        return default
    return value.strip().lower() in {"1", "true", "yes", "on", "ja"}


def _float(value: str | None, default: float) -> float:
    try:
        return float(value) if value not in (None, "") else default
    except ValueError:
        return default


def _int(value: str | None, default: int) -> int:
    try:
        return int(value) if value not in (None, "") else default
    except ValueError:
        return default


SOURCES = ("bol_retailer", "bol_catalog", "aliexpress")


@dataclass
class Env:
    mode: str = "demo"  # "demo" or "live"

    bol_client_id: str = ""
    bol_client_secret: str = ""
    bol_affiliate_client_id: str = ""
    bol_affiliate_client_secret: str = ""

    ali_app_key: str = ""
    ali_app_secret: str = ""
    ali_tracking_id: str = ""

    anthropic_api_key: str = ""
    ai_model: str = "claude-haiku-5-5"

    db_path: Path = BASE_DIR / "data" / "engine.db"
    log_dir: Path = BASE_DIR / "logs"

    scheduler_enabled: bool = True
    daily_run_time: str = "06:30"
    timezone: str = "Europe/Amsterdam"
    run_missed_on_startup: bool = True

    host: str = "127.0.0.1"
    port: int = 8000

    # Live mode only: keep some sources simulated while an account is pending.
    mock_sources: set[str] = field(default_factory=set)
    # Demo mode only: inject occasional HTTP 429s to exercise retry/limit handling.
    demo_simulate_errors: bool = False
    # Demo mode only: pin the simulated "today" (YYYY-MM-DD), for tests.
    demo_today: str = ""

    @property
    def is_live(self) -> bool:
        return self.mode == "live"

    def uses_mock(self, source: str) -> bool:
        """True when this data source is served by the built-in simulator."""
        return (not self.is_live) or source in self.mock_sources

    def has_bol_retailer_credentials(self) -> bool:
        return bool(self.bol_client_id and self.bol_client_secret)

    def has_bol_catalog_credentials(self) -> bool:
        return bool(self.bol_affiliate_client_id and self.bol_affiliate_client_secret)

    def has_ali_credentials(self) -> bool:
        return bool(self.ali_app_key and self.ali_app_secret)

    def has_ai(self) -> bool:
        return bool(self.anthropic_api_key)

    def missing_live_credentials(self) -> list[str]:
        """Names of .env keys that live mode needs but are empty."""
        missing: list[str] = []
        if not self.is_live:
            return missing
        if not self.uses_mock("bol_retailer") and not self.has_bol_retailer_credentials():
            missing += ["BOL_CLIENT_ID", "BOL_CLIENT_SECRET"]
        if not self.uses_mock("bol_catalog") and not self.has_bol_catalog_credentials():
            missing += ["BOL_AFFILIATE_CLIENT_ID", "BOL_AFFILIATE_CLIENT_SECRET"]
        if not self.uses_mock("aliexpress") and not self.has_ali_credentials():
            missing += ["ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET"]
        return missing


def get_env() -> Env:
    """Read the environment fresh every time (cheap, and tests can override)."""
    e = os.environ
    mode = (e.get("ENGINE_MODE") or "demo").strip().lower()
    if mode not in {"demo", "live"}:
        mode = "demo"
    db_path = Path(e.get("DB_PATH") or (BASE_DIR / "data" / "engine.db"))
    if not db_path.is_absolute():
        db_path = BASE_DIR / db_path
    log_dir = Path(e.get("LOG_DIR") or (BASE_DIR / "logs"))
    if not log_dir.is_absolute():
        log_dir = BASE_DIR / log_dir
    mock_sources = {
        s.strip().lower()
        for s in (e.get("MOCK_SOURCES") or "").split(",")
        if s.strip().lower() in SOURCES
    }
    return Env(
        mode=mode,
        bol_client_id=(e.get("BOL_CLIENT_ID") or "").strip(),
        bol_client_secret=(e.get("BOL_CLIENT_SECRET") or "").strip(),
        bol_affiliate_client_id=(e.get("BOL_AFFILIATE_CLIENT_ID") or "").strip(),
        bol_affiliate_client_secret=(e.get("BOL_AFFILIATE_CLIENT_SECRET") or "").strip(),
        ali_app_key=(e.get("ALIEXPRESS_APP_KEY") or "").strip(),
        ali_app_secret=(e.get("ALIEXPRESS_APP_SECRET") or "").strip(),
        ali_tracking_id=(e.get("ALIEXPRESS_TRACKING_ID") or "").strip(),
        anthropic_api_key=(e.get("ANTHROPIC_API_KEY") or "").strip(),
        ai_model=(e.get("AI_MODEL") or "claude-haiku-5-5").strip(),
        db_path=db_path,
        log_dir=log_dir,
        scheduler_enabled=_bool(e.get("SCHEDULER_ENABLED"), True),
        daily_run_time=(e.get("DAILY_RUN_TIME") or "06:30").strip(),
        timezone=(e.get("TIMEZONE") or "Europe/Amsterdam").strip(),
        run_missed_on_startup=_bool(e.get("RUN_MISSED_ON_STARTUP"), True),
        host=(e.get("HOST") or "127.0.0.1").strip(),
        port=_int(e.get("PORT"), 8000),
        mock_sources=mock_sources,
        demo_simulate_errors=_bool(e.get("DEMO_SIMULATE_ERRORS"), False),
        demo_today=(e.get("DEMO_TODAY") or "").strip(),
    )
