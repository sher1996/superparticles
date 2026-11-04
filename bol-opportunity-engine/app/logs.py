"""Logging to logs/engine.log (rotating) and the console."""
from __future__ import annotations

import logging
from logging.handlers import RotatingFileHandler
from pathlib import Path

_configured = False


def setup_logging(log_dir: Path) -> logging.Logger:
    global _configured
    logger = logging.getLogger("engine")
    if _configured:
        return logger
    log_dir.mkdir(parents=True, exist_ok=True)
    fmt = logging.Formatter("%(asctime)s %(levelname)-7s %(message)s", "%Y-%m-%d %H:%M:%S")
    fh = RotatingFileHandler(log_dir / "engine.log", maxBytes=2_000_000, backupCount=5, encoding="utf-8")
    fh.setFormatter(fmt)
    sh = logging.StreamHandler()
    sh.setFormatter(fmt)
    logger.addHandler(fh)
    logger.addHandler(sh)
    logger.setLevel(logging.INFO)
    _configured = True
    return logger
