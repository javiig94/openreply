#!/usr/bin/env python3
"""Forward/paper scanner: today's temperature markets vs the live GFS ensemble.

For a city and a target date (default: tomorrow), this reads the live 31-member
GFS ensemble, builds a probability distribution per bucket (optionally shifted
by a calibration bias you pass in), compares it to the current Polymarket
prices, and prints where the model sees an edge. Read-only: it places NO orders.

Example:
  python scan_live.py --city london --date 2026-11-24 --bias 1.9 --edge 0.07
"""
from __future__ import annotations
import argparse
import datetime as dt

from polyweather import openmeteo as om
from polyweather.config import get_city, CITIES
from polyweather.buckets import INF
from polyweather.model import Calibration, normal_cdf
from polyweather.discover import slug_for
from polyweather.polymarket import fetch_event, price_at


def ensemble_bucket_probs(members: list[float], buckets, cal: Calibration):
    """Empirical P(bucket) from ensemble members, smoothed by cal.sigma.

    Each member is treated as a tiny Gaussian of width sigma (kernel density),
    so sparse 31-member samples still give smooth bucket probabilities.
    """
    mu_shift = cal.bias
    sig = cal.sigma
    out = {}
    for b in buckets:
        acc = 0.0
        for m in members:
            mu = m + mu_shift
            lo = 0.0 if b.low == -INF else normal_cdf(b.low, mu, sig)
            hi = 1.0 if b.high == INF else normal_cdf(b.high, mu, sig)
            acc += (hi - lo)
        out[b.title] = acc / len(members)
    s = sum(out.values())
    return {k: v / s for k, v in out.items()} if s > 0 else out


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", default="london", choices=list(CITIES))
    ap.add_argument("--date", type=lambda s: dt.datetime.strptime(s, "%Y-%m-%d").date(),
                    default=dt.date.today() + dt.timedelta(days=1))
    ap.add_argument("--bias", type=float, default=0.0, help="calibration bias from backtest")
    ap.add_argument("--sigma", type=float, default=2.5, help="calibration sigma from backtest")
    ap.add_argument("--edge", type=float, default=0.07)
    args = ap.parse_args()

    city = get_city(args.city)
    cal = Calibration(bias=args.bias, sigma=args.sigma, n=0)
    slug = slug_for(args.city, args.date)
    print(f"[{city.label}] {args.date}  slug={slug}")

    ev = fetch_event(slug)
    if not ev or not ev.buckets:
        print("  no live market found for that date/slug.")
        return

    members = om.live_ensemble_max(city.lat, city.lon, args.date.isoformat(),
                                   city.unit, city.tz)
    if not members:
        print("  ensemble has no data for that date (too far out / past).")
        return
    print(f"  ensemble: {len(members)} members  "
          f"min={min(members):.1f} mean={sum(members)/len(members):.1f} max={max(members):.1f} {city.unit[0].upper()}")

    model = ensemble_bucket_probs(members, ev.buckets, cal)
    now = int(dt.datetime.now(dt.timezone.utc).timestamp())

    print(f"\n  {'bucket':<16}{'model':>8}{'market':>8}{'edge':>8}  signal")
    print("  " + "-" * 52)
    for b in ev.buckets:
        q = price_at(b.yes_token, now, ev.end_ts or now)
        p = model.get(b.title, 0.0)
        if q is None:
            print(f"  {b.title:<16}{p:>7.1%}{'   —':>8}{'':>8}")
            continue
        edge = p - q
        sig = " <== BUY YES" if edge > args.edge else (" (sell/skip)" if edge < -args.edge else "")
        print(f"  {b.title:<16}{p:>7.1%}{q:>7.1%}{edge:>+7.1%} {sig}")
    print("\n  read-only — no orders placed. size with fractional Kelly and")
    print("  check order-book depth before trusting any 'BUY' on thin books.")


if __name__ == "__main__":
    main()
