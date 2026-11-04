"""Daily scheduler (runs inside the dashboard process).

Runs the funnel every day at DAILY_RUN_TIME (TIMEZONE). If the computer was
off at that time, it runs once at start-up instead (RUN_MISSED_ON_STARTUP).
Alternative for Windows: use Task Scheduler to call `python run_pipeline.py`.
"""
from __future__ import annotations

import threading
from datetime import datetime

from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.cron import CronTrigger

from .config import get_env
from .db import connect
from .logs import setup_logging
from .pipeline.runner import RunAlreadyActive, engine_today, run_daily

_scheduler: BackgroundScheduler | None = None


def _job(trigger: str) -> None:
    logger = setup_logging(get_env().log_dir)
    try:
        run_daily(trigger)
    except RunAlreadyActive:
        logger.warning("Scheduled run skipped: another run is still in progress.")
    except Exception:  # noqa: BLE001
        logger.exception("Scheduled run crashed")


def start_background_run(trigger: str = "manual") -> bool:
    """Start a run in a thread. False if one is already running."""
    from .pipeline.runner import RUN_LOCK
    if RUN_LOCK.locked():
        return False
    threading.Thread(target=_job, args=(trigger,), daemon=True).start()
    return True


def start() -> BackgroundScheduler | None:
    global _scheduler
    env = get_env()
    logger = setup_logging(env.log_dir)
    if not env.scheduler_enabled:
        logger.info("Scheduler disabled (SCHEDULER_ENABLED=false).")
        return None
    try:
        hour, minute = (int(x) for x in env.daily_run_time.split(":"))
    except ValueError:
        logger.error(f"DAILY_RUN_TIME '{env.daily_run_time}' is not HH:MM; using 06:30.")
        hour, minute = 6, 30
    _scheduler = BackgroundScheduler(timezone=env.timezone)
    _scheduler.add_job(_job, CronTrigger(hour=hour, minute=minute, timezone=env.timezone),
                       args=("schedule",), id="daily", replace_existing=True, misfire_grace_time=3600,
                       coalesce=True)
    _scheduler.start()
    logger.info(f"Daily run scheduled at {hour:02d}:{minute:02d} ({env.timezone}).")

    if env.run_missed_on_startup:
        conn = connect(env.db_path)
        today = engine_today(env).isoformat()
        done = conn.execute("SELECT 1 FROM runs WHERE run_date = ? AND status IN ('ok','partial','running')",
                            (today,)).fetchone()
        conn.close()
        now = datetime.now()
        if not done and (now.hour, now.minute) >= (hour, minute):
            logger.info("No run yet today and the scheduled time has passed: starting one now.")
            start_background_run("catch-up")
    return _scheduler


def next_run_time() -> str | None:
    if _scheduler is None:
        return None
    job = _scheduler.get_job("daily")
    return job.next_run_time.isoformat(timespec="minutes") if job and job.next_run_time else None


def stop() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
