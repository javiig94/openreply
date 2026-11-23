#!/usr/bin/env python3
"""Score logged news alerts against realized market resolutions.

Reads data/alerts.log (written by `newsedge.py --watch`), waits for each market
to resolve, then checks whether the inferred side was right and what a bet at the
alert price would have returned. This is the honest validation: does the
news->direction signal actually predict resolution, and does it make money?

  python score_alerts.py
  python score_alerts.py --min-conf 0.6 --only-actionable

Run it after the log has accumulated and the markets have resolved.
"""
from __future__ import annotations
import argparse
import os
import requests

DATA = os.path.join(os.path.dirname(__file__), "data")
GAMMA = "https://gamma-api.polymarket.com"
COLS = ["now", "ts", "score", "source", "side", "conf", "status",
        "base", "cur", "slug", "title", "question"]


def read_log():
    path = os.path.join(DATA, "alerts.log")
    if not os.path.exists(path):
        raise SystemExit(f"no log at {path}; run `newsedge.py --watch` first.")
    rows = []
    for line in open(path):
        parts = line.rstrip("\n").split("\t")
        if len(parts) >= len(COLS):
            rows.append(dict(zip(COLS, parts)))
    return rows


_cache = {}


def resolution(slug):
    """-> 'YES' / 'NO' / None (unresolved)."""
    if slug in _cache:
        return _cache[slug]
    try:
        import json
        d = requests.get(f"{GAMMA}/markets", params={"slug": slug}, timeout=25).json()
        res = None
        if d:
            m = d[0]
            if m.get("closed") and m.get("umaResolutionStatus") == "resolved":
                op = json.loads(m.get("outcomePrices") or "[]")
                if op:
                    res = "YES" if op[0] == "1" else "NO"
    except Exception:  # noqa: BLE001
        res = None
    _cache[slug] = res
    return res


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--min-conf", type=float, default=0.0)
    ap.add_argument("--only-actionable", action="store_true",
                    help="only EARLY/PARTIAL residual (skip PRICED IN / LATE)")
    args = ap.parse_args()

    rows = read_log()
    # dedupe to one alert per (slug, side): keep the earliest
    uniq = {}
    for r in rows:
        if r["side"] in ("None", "", None):
            continue
        if float(r["conf"] or 0) < args.min_conf:
            continue
        if args.only_actionable and not r["status"].startswith(("EARLY", "PARTIAL")):
            continue
        key = (r["slug"], r["side"])
        if key not in uniq or int(r["now"]) < int(uniq[key]["now"]):
            uniq[key] = r

    n = correct = resolved = 0
    pnl = staked = 0.0
    pending = 0
    by_status = {}
    for (slug, side), r in uniq.items():
        res = resolution(slug)
        if res is None:
            pending += 1
            continue
        resolved += 1
        try:
            cur = float(r["cur"])
        except (ValueError, TypeError):
            continue
        hit = (side == res)
        correct += hit
        # bet `side` at alert price `cur` (YES price); settle 0/1
        q = cur if side == "YES" else (1 - cur)
        if 0.01 < q < 0.99:
            pnl += (1 - q) if hit else -q
            staked += q
            n += 1
        st = r["status"].split(" ")[0]
        d = by_status.setdefault(st, [0, 0])
        d[0] += 1; d[1] += hit

    print(f"[score] alerts with a side: {len(uniq)}  resolved: {resolved}  pending: {pending}\n")
    if resolved:
        print(f" direction accuracy : {correct}/{resolved} = {correct/resolved:.1%}")
    if n:
        print(f" simulated bets     : {n}  staked {staked:.1f}")
        print(f" PnL                : {pnl:+.2f}   ROI {pnl/staked:+.1%}")
    print("\n by residual status (accuracy):")
    for st, (tot, hits) in sorted(by_status.items()):
        print(f"   {st:<8} {hits}/{tot} = {hits/tot:.0%}" if tot else "")
    print("\n note: direction accuracy > 50% means the signal predicts resolution;")
    print(" positive ROI on EARLY alerts is the thing that would actually pay.")


if __name__ == "__main__":
    main()
