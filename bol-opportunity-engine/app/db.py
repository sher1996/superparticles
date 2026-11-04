"""SQLite storage. One file (data/engine.db) holds everything, including our own
daily history of ranks, impressions and offers (bol only keeps ~3 months)."""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Iterable

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS keywords (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    term TEXT NOT NULL UNIQUE,
    source TEXT NOT NULL,            -- 'aliexpress', 'bol_related', 'manual'
    source_detail TEXT,              -- e.g. the AliExpress title or parent keyword
    english TEXT,                    -- English search phrase for AliExpress
    status TEXT NOT NULL DEFAULT 'active',   -- active | dormant
    flat_checks INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    last_checked TEXT,
    last_volume INTEGER,
    last_signal_json TEXT
);

CREATE TABLE IF NOT EXISTS search_volume (
    keyword_id INTEGER NOT NULL,
    year INTEGER NOT NULL,
    week INTEGER NOT NULL,
    total INTEGER NOT NULL,
    fetched_at TEXT NOT NULL,
    PRIMARY KEY (keyword_id, year, week)
);

CREATE TABLE IF NOT EXISTS keyword_signals (
    keyword_id INTEGER NOT NULL,
    run_date TEXT NOT NULL,
    is_rising INTEGER NOT NULL,
    signal_json TEXT NOT NULL,
    PRIMARY KEY (keyword_id, run_date)
);

CREATE TABLE IF NOT EXISTS bol_products (
    ean TEXT PRIMARY KEY,
    title TEXT,
    url TEXT,
    image_url TEXT,
    first_seen TEXT NOT NULL,
    last_seen TEXT NOT NULL,
    backfilled INTEGER NOT NULL DEFAULT 0,
    tracked INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS keyword_products (
    keyword_id INTEGER NOT NULL,
    ean TEXT NOT NULL,
    run_date TEXT NOT NULL,
    position INTEGER NOT NULL,
    PRIMARY KEY (keyword_id, ean, run_date)
);

CREATE TABLE IF NOT EXISTS product_snapshots (
    ean TEXT NOT NULL,
    date TEXT NOT NULL,
    price REAL,
    offers_count INTEGER,
    fbb_offers INTEGER,
    review_count INTEGER,
    rating REAL,
    delivery TEXT,
    PRIMARY KEY (ean, date)
);

CREATE TABLE IF NOT EXISTS product_ranks (
    ean TEXT NOT NULL,
    date TEXT NOT NULL,
    search_term TEXT NOT NULL,
    rank INTEGER,
    impressions INTEGER,
    sponsored INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (ean, date, search_term, sponsored)
);

CREATE TABLE IF NOT EXISTS ali_products (
    product_id TEXT PRIMARY KEY,
    title TEXT,
    image_url TEXT,
    url TEXT,
    price REAL,
    original_price REAL,
    currency TEXT,
    volume INTEGER,
    rating REAL,
    category TEXT,
    category2 TEXT,
    shipping REAL,
    delivery_days INTEGER,
    fetched_at TEXT NOT NULL,
    raw_json TEXT
);

CREATE TABLE IF NOT EXISTS opportunities (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_date TEXT NOT NULL,
    keyword_id INTEGER NOT NULL,
    keyword TEXT NOT NULL,
    ean TEXT,
    ali_product_id TEXT,
    status TEXT NOT NULL DEFAULT 'new',      -- new | approved | rejected
    filtered INTEGER NOT NULL DEFAULT 0,      -- 1 = dropped by a filter (see filter_reasons)
    filter_reasons_json TEXT,
    score REAL,
    base_score REAL,
    learning_adj REAL,
    parts_json TEXT,
    explanation TEXT,
    explanation_source TEXT,
    profit_json TEXT,
    profit_eur REAL,
    margin REAL,
    sale_price REAL,
    match_confidence REAL,
    match_reason TEXT,
    match_source TEXT,
    risk_json TEXT,
    printable INTEGER NOT NULL DEFAULT 0,
    print_json TEXT,
    competitors_json TEXT,
    demand_json TEXT,
    also_keywords_json TEXT,
    features_json TEXT,
    decision_reason TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (run_date, keyword_id)
);
CREATE INDEX IF NOT EXISTS idx_opps_date ON opportunities(run_date, filtered, status);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    opportunity_id INTEGER NOT NULL,
    keyword_id INTEGER NOT NULL,
    ali_product_id TEXT,
    decision TEXT NOT NULL,                  -- approved | rejected
    reason TEXT,
    features_json TEXT,
    score REAL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    run_date TEXT NOT NULL,
    mode TEXT NOT NULL,
    trigger TEXT NOT NULL,
    status TEXT NOT NULL,                    -- running | ok | partial | failed
    summary_json TEXT
);

CREATE TABLE IF NOT EXISTS run_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id INTEGER,
    ts TEXT NOT NULL,
    level TEXT NOT NULL,
    step TEXT,
    message TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ai_usage (
    date TEXT PRIMARY KEY,
    calls INTEGER NOT NULL DEFAULT 0,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS ai_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL
);
"""


def connect(db_path: Path | str) -> sqlite3.Connection:
    path = Path(db_path)
    if str(path) != ":memory:":
        path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=30, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    conn.executescript(SCHEMA_SQL)
    return conn


def dumps(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, default=str)


def loads(value: str | None, default: Any = None) -> Any:
    if value in (None, ""):
        return default
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return default


def rows(cursor: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(r) for r in cursor]
