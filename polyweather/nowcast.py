#!/usr/bin/env python3
"""Strategy D — live-observation nowcast ("read the thermometer, not the forecast").

This is the one angle that matches the intuition "an API that is right in high
proportion + people who haven't checked yet". The accurate 'API' here is the
THERMOMETER: the day's running maximum. Once the observed max-so-far reaches
X, every bucket whose whole range is below X is MATHEMATICALLY DEAD — it cannot
be the day's high. If the market still pays >0 for those dead buckets, a laggard
is leaving money on the table.

This does NOT predict anything. It reads the present faster than the crowd.

Method (per event, at several decision hours of the resolution day):
  - pull hourly OBSERVED temperature up to hour H (ERA5 archive, local tz)
  - max_so_far = max of observed hours
  - a bucket is DEAD if its HIGH edge < max_so_far (even its top is already
    exceeded). Using ERA5 (which tends to read a touch low vs the airport
    station) makes this CONSERVATIVE: we under-count dead buckets, not over.
  - read the market's last price for each dead bucket at that timestamp
  - tally the "dead dollars" still quoted and whether the realised winner was
    indeed above them (sanity: a flagged-dead bucket should never be the winner)

Caveat: cached prices are last-trade, not executable quotes. A positive screen
means "the signal exists"; capturing it needs the live order book (see the live
book probe — these books can be sharp). Treat this as a screen, not a P&L.
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os

from zoneinfo import ZoneInfo

from polyweather import openmeteo as om
from polyweather.config import get_city, CITIES

DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


def load_cache(city_key, start, end):
    path = os.path.join(DATA_DIR, f"{city_key}_{start}_{end}.json")
    if not os.path.exists(path):
        raise SystemExit(f"no cache at {path}; run research.py first.")
    return json.load(open(path))


def hourly_obs(city, start, end):
    """ERA5 hourly temp, {('YYYY-MM-DD', hour_local): temp}."""
    d = om._get(om._ARCHIVE, {
        "latitude": city.lat, "longitude": city.lon,
        "start_date": start, "end_date": end,
        "hourly": "temperature_2m",
        "temperature_unit": city.unit, "timezone": city.tz,
    })
    h = d.get("hourly", {})
    out = {}
    for t, v in zip(h.get("time", []), h.get("temperature_2m", [])):
        if v is None:
            continue
        date, hhmm = t.split("T")
        out[(date, int(hhmm[:2]))] = v
    return out


def price_at(hist, as_of_ts):
    prior = [p for (t, p) in hist if t <= as_of_ts]
    return prior[-1] if prior else None


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", default="london", choices=list(CITIES))
    ap.add_argument("--start", required=True)
    ap.add_argument("--end", required=True)
    ap.add_argument("--hours", type=int, nargs="+", default=[13, 14, 15, 16, 17])
    ap.add_argument("--min-price", type=float, default=0.03,
                    help="ignore dead buckets quoted below this (noise)")
    args = ap.parse_args()

    city = get_city(args.city)
    ds = load_cache(args.city, args.start, args.end)
    obs = hourly_obs(city, args.start, args.end)
    print(f"[nowcast] {city.label}  {len(ds)} events  obs-hours {args.hours}\n")

    print(f"{'hour':>5} {'events':>7} {'dead$>min':>9} {'avg_dead$':>9} "
          f"{'maxbucket':>9} {'false_dead':>10}")
    print("-" * 56)
    for H in args.hours:
        n_ev = 0
        total_dead = 0.0
        max_single = 0.0
        false_dead = 0            # flagged dead but actually won (should be 0)
        for ev in ds:
            date = ev["date"]
            maxsofar = max((obs[(date, h)] for h in range(0, H + 1)
                            if (date, h) in obs), default=None)
            if maxsofar is None:
                continue
            # decision timestamp = hour H local that day -> UTC unix
            y, mo, da = (int(x) for x in date.split("-"))
            as_of = int(dt.datetime(y, mo, da, H, 0, tzinfo=ZoneInfo(city.tz)).timestamp())
            n_ev_counted = False
            dead_dollars = 0.0
            for b in ev["buckets"]:
                if b["high"] < maxsofar:          # whole bucket below observed max => dead
                    q = price_at(b["history"], as_of)
                    if q is None:
                        continue
                    if not n_ev_counted:
                        n_ev += 1; n_ev_counted = True
                    if q >= args.min_price:
                        dead_dollars += q
                        max_single = max(max_single, q)
                    if b["title"] == ev["winner"]:
                        false_dead += 1
            total_dead += dead_dollars
        avg = total_dead / n_ev if n_ev else 0.0
        print(f"{H:>5} {n_ev:>7} {total_dead:>9.2f} {avg:>9.3f} "
              f"{max_single:>9.2f} {false_dead:>10}")
    print("\nfalse_dead must be 0 (a bucket below the observed max can't be the high).")
    print("avg_dead$ = mean $ of dead-bucket YES still quoted per event at that hour.")
    print("That is the size of the laggard mistake you could fade — IF the live book")
    print("lets you fill (these numbers are last-trade, not executable quotes).")


if __name__ == "__main__":
    main()
