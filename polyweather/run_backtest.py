#!/usr/bin/env python3
"""CLI: backtest a calibrated weather forecast vs Polymarket, out-of-sample.

Examples:
  python run_backtest.py --city london --start 2025-05-01 --end 2025-09-30
  python run_backtest.py --city nyc --start 2025-06-01 --end 2025-08-31 \
      --lead 24 --edge 0.07 --kelly 0.25
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
    ap.add_argument("--train-frac", type=float, default=0.5)
    ap.add_argument("--lead", type=int, default=24, help="decision lead hours before close")
    ap.add_argument("--edge", type=float, default=0.07, help="min model-market edge to bet")
    ap.add_argument("--kelly", type=float, default=0.25, help="fractional Kelly multiplier")
    ap.add_argument("--max-stake", type=float, default=100.0)
    ap.add_argument("--quiet", action="store_true")
    args = ap.parse_args()

    r = run(args.city, args.start, args.end,
            train_frac=args.train_frac, lead_hours=args.lead,
            edge_threshold=args.edge, kelly_frac=args.kelly,
            max_stake=args.max_stake, verbose=not args.quiet)

    print("\n" + "=" * 62)
    print(f" RESULT  {r.city}")
    print("=" * 62)
    print(f" train events      : {r.n_train}")
    print(f" test events scored : {r.n_test}")
    print(f" calibration        : bias={r.cal.bias:+.2f}  sigma={r.cal.sigma:.2f}  (n={r.cal.n})")
    print("-" * 62)
    print(f" Brier  model       : {r.brier_model:.4f}   (lower=better)")
    print(f" Brier  market      : {r.brier_market:.4f}")
    print(f" Brier  uniform     : {r.brier_uniform:.4f}")
    verdict = "MODEL beats market" if r.brier_model < r.brier_market else "market beats model"
    print(f"   -> {verdict}  (diff {r.brier_market - r.brier_model:+.4f})")
    print("-" * 62)
    print(f" argmax hit  model  : {r.model_hit:.1%}")
    print(f" argmax hit  market : {r.market_hit:.1%}")
    print("-" * 62)
    n_win = sum(1 for t in r.trades if t.won)
    print(f" edge trades        : {len(r.trades)}  (won {n_win})")
    print(f" simulated ROI      : {r.roi:+.1%}")
    if r.bankroll_curve:
        print(f" bankroll 1000 ->   : {r.bankroll_curve[-1]:,.0f}")
    print("=" * 62)
    print(" NOTE: thin-liquidity slippage is NOT modelled; real fills on large")
    print(" stakes will be worse. Treat positive ROI as 'edge exists', not 'profit'.")


if __name__ == "__main__":
    main()
