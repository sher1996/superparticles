"""Step 2 - Demand: is a keyword's bol search volume really trending?

A keyword counts as rising only when ALL of these are true:
  * enough searches (average of the last 4 weeks >= minimum),
  * the last 4 weeks beat the 4 weeks before (week-over-week growth),
  * most recent weeks went up, not down,
  * the last 4 weeks beat the SAME 4 weeks last year, and
  * this year's growth beats last year's growth over the same weeks
    (so the normal Christmas run-up does not count as a trend).
Then we estimate how early we are: young, still accelerating, not past a peak.
"""
from __future__ import annotations

from datetime import date, timedelta
from statistics import median
from typing import Any


def _iso_monday(year: int, week: int) -> date:
    return date.fromisocalendar(year, week, 1)


def analyse_series(periods: list[tuple[int, int, int]], settings: dict[str, Any]) -> dict[str, Any]:
    """periods: [(iso_year, iso_week, searches)] in any order. Returns signal dict."""
    by_week = {(y, w): v for y, w, v in periods}
    ordered = sorted(periods)
    values = [v for _y, _w, v in ordered]
    sig: dict[str, Any] = {"is_rising": False, "reasons": [], "weeks": len(values)}
    if len(values) < 10:
        sig["reasons"].append("not enough search history yet")
        return sig

    cur4 = sum(values[-4:])
    prev4 = sum(values[-8:-4])
    avg = cur4 / 4
    wow = (cur4 / prev4 - 1) if prev4 else (1.0 if cur4 else 0.0)
    deltas = [values[i] - values[i - 1] for i in range(len(values) - 4, len(values))]
    up_weeks = sum(1 for d in deltas if d > 0)

    # same weeks last year (by ISO week number, so it lines up with the calendar)
    last_weeks = [(y, w) for y, w, _v in ordered[-8:]]
    ly = []
    for y, w in last_weeks:
        try:
            d = _iso_monday(y, w) - timedelta(weeks=52)
        except ValueError:
            ly.append(None)
            continue
        iso = d.isocalendar()
        ly.append(by_week.get((iso[0], iso[1])))
    have_ly = all(v is not None for v in ly)
    yoy = ly_growth = excess = None
    if have_ly:
        ly_cur4, ly_prev4 = sum(ly[-4:]), sum(ly[:4])
        yoy = (cur4 / ly_cur4 - 1) if ly_cur4 else (5.0 if cur4 else 0.0)
        ly_growth = (ly_cur4 / ly_prev4 - 1) if ly_prev4 else 0.0
        excess = wow - ly_growth

    # earliness -------------------------------------------------------------
    baseline_window = values[-30:-8] if len(values) >= 30 else values[:-8]
    baseline = median(baseline_window) if baseline_window else values[0]
    weeks_rising = 0
    for v in reversed(values):
        if v > baseline * 1.25:
            weeks_rising += 1
        else:
            break
    peak12 = max(values[-12:])
    peak_pos = len(values) - 12 + values[-12:].index(peak12)
    weeks_since_peak = len(values) - 1 - peak_pos
    off_peak = values[-1] / peak12 if peak12 else 0.0
    g_recent = (sum(values[-2:]) / sum(values[-4:-2]) - 1) if sum(values[-4:-2]) else 0.0
    g_before = (sum(values[-4:-2]) / sum(values[-6:-4]) - 1) if sum(values[-6:-4]) else 0.0
    accelerating = g_recent > 0 and g_recent >= g_before * 0.85
    older = values[:-16]
    old_peak = max(older) if older else 0
    had_bigger_peak_before = bool(old_peak and old_peak > values[-1] * 1.1)

    youth = 1 - min(1.0, max(0, weeks_rising - 1) / 14)
    accel_score = 1.0 if accelerating else (0.5 if g_recent > 0 else 0.0)
    peak_score = 1.0 if (weeks_since_peak == 0 or off_peak >= 0.97) else max(0.0, (off_peak - 0.6) / 0.37)
    earliness = 0.35 * youth + 0.35 * accel_score + 0.30 * peak_score
    if had_bigger_peak_before:
        earliness *= 0.6
    stage = "early" if earliness >= 0.65 else ("growing" if earliness >= 0.4 else "late")

    sig.update({
        "avg_weekly": round(avg, 1), "last_week": values[-1], "growth_4w": round(wow, 3),
        "up_weeks": up_weeks, "yoy": None if yoy is None else round(yoy, 3),
        "ly_growth": None if ly_growth is None else round(ly_growth, 3),
        "excess_growth": None if excess is None else round(excess, 3),
        "weeks_rising": weeks_rising, "accelerating": accelerating,
        "off_peak": round(off_peak, 3), "weeks_since_peak": weeks_since_peak,
        "earliness": round(earliness, 3), "stage": stage, "has_last_year": have_ly,
        "had_bigger_peak_before": had_bigger_peak_before,
    })

    reasons = sig["reasons"]
    ok = True
    if avg < settings["min_weekly_volume"]:
        ok = False
        reasons.append(f"too few searches ({avg:.0f}/week)")
    if wow < settings["min_wow_growth"]:
        ok = False
        reasons.append(f"not rising enough ({wow:+.0%} in 4 weeks)")
    if up_weeks < 2:
        ok = False
        reasons.append("recent weeks are not going up")
    if have_ly:
        if yoy < settings["min_yoy_growth"]:
            ok = False
            reasons.append(f"not higher than last year ({yoy:+.0%})")
        if excess < settings["min_excess_growth"]:
            ok = False
            if ly_growth >= 0.10:
                reasons.append(f"seasonal: it grew just as much at this time last year ({ly_growth:+.0%} then)")
            elif wow >= settings["min_wow_growth"]:
                reasons.append("growth is not clearly above last year's growth for these weeks")
    else:
        # no last-year data: demand a much stronger rise before we trust it
        if wow < settings["min_wow_growth"] * 2:
            ok = False
            reasons.append("new keyword without last-year data and the rise is not strong enough yet")
    if weeks_since_peak >= 3 and off_peak < 0.85:
        ok = False
        reasons.append(f"already past its peak ({weeks_since_peak} weeks ago)")
    sig["is_rising"] = ok
    return sig


def last_year_overlay(periods: list[tuple[int, int, int]], weeks: int = 52) -> dict[str, list]:
    """Data for the chart: the last `weeks` weeks and the same weeks one year earlier."""
    by_week = {(y, w): v for y, w, v in periods}
    ordered = sorted(periods)[-weeks:]
    labels, this_year, last_year = [], [], []
    for y, w, v in ordered:
        labels.append(f"{y}-W{w:02d}")
        this_year.append(v)
        try:
            d = _iso_monday(y, w) - timedelta(weeks=52)
            iso = d.isocalendar()
            last_year.append(by_week.get((iso[0], iso[1])))
        except ValueError:
            last_year.append(None)
    return {"labels": labels, "this_year": this_year, "last_year": last_year}
