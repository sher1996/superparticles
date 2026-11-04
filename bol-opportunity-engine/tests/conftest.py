import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


@pytest.fixture(autouse=True)
def demo_env(tmp_path, monkeypatch):
    """Every test gets its own empty database in demo mode, no AI, fixed date."""
    for key in ["BOL_CLIENT_ID", "BOL_CLIENT_SECRET", "BOL_AFFILIATE_CLIENT_ID", "BOL_AFFILIATE_CLIENT_SECRET",
                "ALIEXPRESS_APP_KEY", "ALIEXPRESS_APP_SECRET", "ANTHROPIC_API_KEY", "MOCK_SOURCES",
                "DEMO_SIMULATE_ERRORS"]:
        monkeypatch.setenv(key, "")
    monkeypatch.setenv("ENGINE_MODE", "demo")
    monkeypatch.setenv("DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("LOG_DIR", str(tmp_path / "logs"))
    monkeypatch.setenv("DEMO_TODAY", "2026-11-04")
    monkeypatch.setenv("SCHEDULER_ENABLED", "false")
    yield tmp_path


@pytest.fixture
def settings():
    from app.settings import defaults
    return defaults()
