"""Run the daily funnel once, without the dashboard: python run_pipeline.py
Useful for Windows Task Scheduler / cron. Exit code 0 = ok, 1 = partial, 2 = failed."""
import sys

from app.config import get_env
from app.db import connect, loads
from app.pipeline.runner import RunAlreadyActive, run_daily

if __name__ == "__main__":
    try:
        run_id = run_daily("cli")
    except RunAlreadyActive as exc:
        print(exc)
        sys.exit(2)
    conn = connect(get_env().db_path)
    row = conn.execute("SELECT status, summary_json FROM runs WHERE id = ?", (run_id,)).fetchone()
    summary = loads(row["summary_json"], {})
    print(f"Run {run_id}: {row['status']} - {summary.get('opportunities', 0)} opportunities, "
          f"{summary.get('rising', 0)} rising keywords")
    for err in summary.get("errors", []):
        print("ERROR:", err)
    sys.exit({"ok": 0, "partial": 1}.get(row["status"], 2))
