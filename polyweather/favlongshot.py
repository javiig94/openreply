#!/usr/bin/env python3
"""Favorite-longshot bias study across ALL resolved Polymarket binary markets.

The most documented edge in betting markets: longshots (low prob) are
over-priced, favorites (high prob) under-priced. If it holds on Polymarket —
which charges NO trading fee — even a small bias is tradeable.

Each resolved binary market is ONE independent observation: take the YES price
at a fixed lead before resolution, pair it with the realized outcome (0/1), then
bin by price and compare realized frequency to price. Thousands of markets =
real statistical power (unlike 150 autocorrelated weather days).

  python favlongshot.py --collect --n 1500 --min-vol 50000 --lead 48
  python favlongshot.py --analyze --lead 48
"""
from __future__ import annotations
import argparse
import json
import os
import time
import requests

DATA = os.path.join(os.path.dirname(__file__), "data")
GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
S = requests.Session()
S.headers["User-Agent"] = "polyweather-flsb/0.1"


def _get(url, params, tries=4):
    last = None
    for i in range(tries):
        try:
            r = S.get(url, params=params, timeout=40)
            if r.status_code == 429:
                time.sleep(2 * (i + 1)); continue
            r.raise_for_status(); return r.json()
        except Exception as e:  # noqa: BLE001
            last = e; time.sleep(1.2 * (i + 1))
    raise RuntimeError(f"{url}: {last}")


def iso_ts(iso):
    import datetime as dt
    return int(dt.datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp())


def price_at(token, as_of, window_end=None):
    # interval=max returns the whole life of the market in one call; the
    # startTs/endTs+fidelity mode 400s on many ranges, so avoid it.
    d = _get(f"{CLOB}/prices-history",
             {"market": token, "interval": "max", "fidelity": 720})
    hist = [(int(p["t"]), float(p["p"])) for p in d.get("history", [])]
    prior = [p for (t, p) in hist if t <= as_of]
    return prior[-1] if prior else None


def collect(n_target, min_vol, lead_hours):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, f"flsb_lead{lead_hours}.json")
    rows = []
    seen = set()
    offset = 0
    page = 100
    max_offset = 12000           # guard against endless paging
    while len(rows) < n_target and offset < max_offset:
        batch = _get(f"{GAMMA}/markets", {
            "closed": "true", "limit": page, "offset": offset,
            "order": "volumeNum", "ascending": "false"})
        if not batch:
            break
        offset += page
        print(f"  [page offset={offset}] have {len(rows)} rows")
        for m in batch:
            try:
                vol = float(m.get("volumeNum") or 0)
            except (TypeError, ValueError):
                vol = 0
            if vol < min_vol:
                # sorted desc by volume: once below threshold we can stop
                batch = []
                break
            oc = json.loads(m.get("outcomes") or "[]")
            op = json.loads(m.get("outcomePrices") or "[]")
            toks = json.loads(m.get("clobTokenIds") or "[]")
            if oc != ["Yes", "No"] or len(toks) != 2 or len(op) != 2:
                continue
            if m.get("umaResolutionStatus") != "resolved" or not m.get("endDate"):
                continue
            cid = m.get("conditionId")
            if cid in seen:
                continue
            seen.add(cid)
            yes_won = 1 if op[0] == "1" else (0 if op[1] == "1" else None)
            if yes_won is None:
                continue
            end_ts = iso_ts(m["endDate"])
            try:
                p = price_at(toks[0], end_ts - lead_hours * 3600, end_ts)
            except Exception:  # noqa: BLE001
                p = None
            time.sleep(0.12)   # be gentle with the CLOB endpoint
            if p is None:
                continue
            rows.append({"q": m.get("question", "")[:80], "vol": vol,
                         "price": p, "yes_won": yes_won, "end": m["endDate"]})
            if len(rows) % 50 == 0:
                print(f"  collected {len(rows)} (offset {offset}, vol~{vol:,.0f})")
            if len(rows) >= n_target:
                break
        if not batch:
            break
    json.dump(rows, open(path, "w"))
    print(f"[flsb] saved {len(rows)} markets -> {path}")
    return rows


def categorize(q: str) -> str:
    s = q.lower()
    if any(w in s for w in ['nba', 'nfl', 'nhl', 'mlb', ' vs ', 'vs.', 'win the', 'beat ',
                            'ufc', 'premier', 'la liga', 'champions', 'super bowl', 'playoff',
                            'game ', 'match', 'defeat', 'tournament', 'cup', 'grand prix', 'f1']):
        return 'sports'
    if any(w in s for w in ['bitcoin', 'btc', 'ethereum', 'eth', 'crypto', 'solana', '$',
                            'dogecoin', 'token', 'coin', 'price of', 'market cap', 'ath']):
        return 'crypto'
    if any(w in s for w in ['election', 'president', 'senate', 'congress', 'nominee', 'vote',
                            'governor', 'prime minister', 'parliament', 'poll', 'democrat',
                            'republican', 'trump', 'biden', 'harris', 'mayor', 'cabinet',
                            'resign', 'impeach']):
        return 'politics'
    if any(w in s for w in ['fed', 'interest rate', 'inflation', 'cpi', 'gdp', 'recession',
                            'jobs', 'unemployment', 'rate cut', 'rate hike']):
        return 'econ'
    return 'other'


def _roi(rows, side_fn, spread=0.0):
    """ROI holding to resolution. `spread` is the half-spread you pay on entry
    (e.g. 0.01 = you buy 1 cent worse than the mid). Models execution cost."""
    staked = pnl = 0.0
    n = w = 0
    for r in rows:
        bet = side_fn(r)
        if bet is None:
            continue
        mid = r["price"] if bet == "yes" else 1 - r["price"]
        q = mid + spread                 # pay up to cross the spread
        if q <= 0.02 or q >= 0.98:
            continue
        won = (r["yes_won"] == 1) if bet == "yes" else (r["yes_won"] == 0)
        pnl += (1 - q) if won else -q
        staked += q
        n += 1
        w += int(won)
    return n, (w / n if n else 0), (pnl / staked if staked else 0), pnl


def by_category(lead_hours, spread=0.0):
    rows = json.load(open(os.path.join(DATA, f"flsb_lead{lead_hours}.json")))
    from collections import defaultdict
    g = defaultdict(list)
    for r in rows:
        g[categorize(r["q"])].append(r)
    print(f"[flsb] {len(rows)} markets @ {lead_hours}h lead, spread cost={spread:.3f}\n")
    print(f"{'category':<9}{'mkts':>5} |  back UNDERDOG (longshot side)")
    print(f"{'':9}{'':>5} |   n   win    ROI     PnL")
    print("-" * 46)
    for c in ['sports', 'crypto', 'politics', 'econ', 'other']:
        n, wr, roi, pnl = _roi(g[c], lambda r: "no" if r["price"] > 0.5 else "yes", spread)
        print(f"{c:<9}{len(g[c]):>5} | {n:>3} {wr:5.0%} {roi:+7.1%} {pnl:+7.1f}")


def analyze(lead_hours):
    path = os.path.join(DATA, f"flsb_lead{lead_hours}.json")
    rows = json.load(open(path))
    print(f"[flsb] {len(rows)} resolved binary markets, price @ {lead_hours}h before close\n")

    # calibration table: bin YES price, compare to realized YES frequency
    bins = [(i / 20, (i + 1) / 20) for i in range(20)]
    print(f"{'price bin':>12} {'n':>5} {'avg_price':>9} {'realized':>9} {'gap(real-price)':>16}")
    print("-" * 56)
    for lo, hi in bins:
        sel = [r for r in rows if lo <= r["price"] < hi]
        if not sel:
            continue
        ap = sum(r["price"] for r in sel) / len(sel)
        rf = sum(r["yes_won"] for r in sel) / len(sel)
        flag = "  <= longshot overpriced" if (ap < 0.5 and rf < ap - 0.02) else \
               ("  <= favorite underpriced" if (ap > 0.5 and rf > ap + 0.02) else "")
        print(f"{lo:.2f}-{hi:.2f}   {len(sel):>5} {ap:>9.3f} {rf:>9.3f} {rf-ap:>+16.3f}{flag}")

    # tradeable strategies, hold to resolution, 0% fee
    def roi(side_fn, label):
        staked = pnl = 0.0; n = w = 0
        for r in rows:
            bet = side_fn(r)             # 'yes', 'no', or None
            if bet is None:
                continue
            q = r["price"] if bet == "yes" else 1 - r["price"]
            if q <= 0.02 or q >= 0.98:
                continue
            won = (r["yes_won"] == 1) if bet == "yes" else (r["yes_won"] == 0)
            pnl += (1 - q) if won else -q
            staked += q; n += 1; w += int(won)
        if staked:
            print(f"  {label:<34} n={n:>5} win={w/n:5.1%} ROI={pnl/staked:+7.2%} PnL/stk={pnl:+.1f}/{staked:.0f}")

    print("\nStrategies (hold to resolution, Polymarket 0% trading fee):")
    roi(lambda r: "yes" if r["price"] > 0.5 else "no", "back the FAVORITE (p>0.5 side)")
    roi(lambda r: "no" if r["price"] > 0.5 else "yes", "back the LONGSHOT (p<0.5 side)")
    roi(lambda r: "yes" if r["price"] >= 0.80 else None, "back heavy favorites (YES p>=0.80)")
    roi(lambda r: "no" if r["price"] <= 0.20 else None, "fade heavy longshots (buy NO, p<=0.20)")
    roi(lambda r: "yes" if 0.90 <= r["price"] < 0.98 else None, "buy near-certain YES (0.90-0.98)")
    print("\npositive ROI on favorites + negative on longshots == favorite-longshot bias is real & tradeable.")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--collect", action="store_true")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("--by-category", action="store_true")
    ap.add_argument("--spread", type=float, default=0.0, help="half-spread entry cost")
    ap.add_argument("--n", type=int, default=1500)
    ap.add_argument("--min-vol", type=float, default=50000)
    ap.add_argument("--lead", type=int, default=48)
    args = ap.parse_args()
    if args.collect:
        collect(args.n, args.min_vol, args.lead)
    if args.analyze:
        analyze(args.lead)
    if args.by_category:
        by_category(args.lead, args.spread)


if __name__ == "__main__":
    main()
