#!/usr/bin/env python3
"""Robustness check: run the backtest at several decision leads.

The key honesty test. A model can look good against a thin, immature market 24h
out and lose to a sharp market 3h out. If the edge survives at short lead, it is
real (if hard to capture); if it only exists at long lead, you were beating an
unformed market, not the market.

  python compare_leads.py --city london --start 2025-05-01 --end 2025-09-30
"""
from __future__ import annotations
import argparse
import datetime as dt

from polyweather.backtest import run
from polyweather.config import CITIES


def _date(s: str) -> dt.date:
    return dt.datetime.strptime(s, "%Y-%m-%d").date()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", default="london", choices=list(CITIES))
    ap.add_argument("--start", type=_date, required=True)
    ap.add_argument("--end", type=_date, required=True)
    ap.add_argument("--leads", type=int, nargs="+", default=[48, 24, 12, 6, 3])
    args = ap.parse_args()

    print(f"{'lead':>5} {'n':>4} {'brier_mdl':>10} {'brier_mkt':>10} "
          f"{'diff':>8} {'mdl_hit':>8} {'mkt_hit':>8} {'trades':>7} {'ROI':>8}")
    print("-" * 74)
    for lead in args.leads:
        try:
            r = run(args.city, args.start, args.end, lead_hours=lead, verbose=False)
        except Exception as e:  # noqa: BLE001
            print(f"{lead:>5}  error: {e}")
            continue
        diff = r.brier_market - r.brier_model
        print(f"{lead:>5} {r.n_test:>4} {r.brier_model:>10.4f} {r.brier_market:>10.4f} "
              f"{diff:>+8.4f} {r.model_hit:>7.1%} {r.market_hit:>7.1%} "
              f"{len(r.trades):>7} {r.roi:>+7.1%}")
    print("-" * 74)
    print("positive diff = model beats market. Trust it only if it holds at short lead.")


if __name__ == "__main__":
    main()
