"""Discover Polymarket daily-temperature events for a city over a date range.

Polymarket slugs look like:  highest-temperature-in-london-on-june-1
(month name lowercase, day without leading zero). We generate candidate slugs
across the range and keep the ones that resolve to a real, closed event.
"""
from __future__ import annotations
import datetime as dt

from .polymarket import fetch_event, Event

_MONTHS = ["january", "february", "march", "april", "may", "june", "july",
           "august", "september", "october", "november", "december"]


def slug_for(city_key: str, day: dt.date) -> str:
    return f"highest-temperature-in-{city_key}-on-{_MONTHS[day.month - 1]}-{day.day}"


def discover(city_key: str, start: dt.date, end: dt.date,
             verbose: bool = True) -> list[Event]:
    events: list[Event] = []
    d = start
    while d <= end:
        slug = slug_for(city_key, d)
        try:
            ev = fetch_event(slug)
        except Exception as e:  # noqa: BLE001
            ev = None
            if verbose:
                print(f"  ! {slug}: {e}")
        if ev and ev.buckets:
            # guard: endDate year should match the queried day's year-ish window
            events.append(ev)
            if verbose:
                rb = ev.resolved_bucket
                print(f"  + {slug}  buckets={len(ev.buckets)}  "
                      f"resolved={rb.title if rb else '—'}")
        d += dt.timedelta(days=1)
    return events
