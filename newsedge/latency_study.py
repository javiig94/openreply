#!/usr/bin/env python3
"""How fast does Polymarket reprice? Measures the tradeable reaction window.

For a sample of news-sensitive active markets, pulls 1-minute price history,
finds each market's largest sustained move, and measures the TRANSITION TIME:
minutes for the price to travel from 10% to 90% of that move. That window is
how long you have to act after spotting the catalyst.

  median transition > ~10-15 min  -> a retail news monitor can plausibly act
  median transition < ~2 min       -> the move is a gap; you cannot beat it

  python latency_study.py --n 60
"""
from __future__ import annotations
import argparse
import json
import statistics
import time
import requests

GAMMA = "https://gamma-api.polymarket.com"
CLOB = "https://clob.polymarket.com"
SPORT = [" vs ", " vs.", "dota", "cs2", "nba", "nfl", "map 1", "spread:",
         "counter-strike", "valorant", "moneyline", "ufc", "tennis", "game 1"]


def _get(url, params, tries=4):
    last = None
    for i in range(tries):
        try:
            r = requests.get(url, params=params, timeout=30)
            if r.status_code != 200:
                last = f"{r.status_code}"; time.sleep(1); continue
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e; time.sleep(1.2 * (i + 1))
    return None


def minute_history(token):
    d = _get(f"{CLOB}/prices-history", {"market": token, "interval": "1d", "fidelity": 1})
    if not d:
        return []
    return [(int(p["t"]), float(p["p"])) for p in d.get("history", [])]


def largest_move_transition(hist, window=60):
    """Find the largest price change over any `window`-minute span, then measure
    minutes from 10% to 90% of that move. Returns (abs_move, transition_min)."""
    n = len(hist)
    if n < window + 2:
        return None
    best_i = best_j = 0
    best = 0.0
    # rolling window on index (data is ~1/min)
    for i in range(n - window):
        j = i + window
        mv = abs(hist[j][1] - hist[i][1])
        if mv > best:
            best = mv; best_i, best_j = i, j
    if best < 0.08:                     # ignore noise-level moves (<8c)
        return None
    p0 = hist[best_i][1]
    p1 = hist[best_j][1]
    lo = p0 + 0.10 * (p1 - p0)
    hi = p0 + 0.90 * (p1 - p0)
    t_lo = t_hi = None
    rising = p1 > p0
    for k in range(best_i, best_j + 1):
        p = hist[k][1]
        if t_lo is None and ((rising and p >= lo) or (not rising and p <= lo)):
            t_lo = hist[k][0]
        if (rising and p >= hi) or (not rising and p <= hi):
            t_hi = hist[k][0]; break
    if t_lo is None or t_hi is None:
        return None
    return best, max(0, (t_hi - t_lo) / 60.0)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--n", type=int, default=60)
    args = ap.parse_args()

    rows = _get(f"{GAMMA}/markets", {"active": "true", "closed": "false",
                                     "limit": 500, "order": "volume24hr",
                                     "ascending": "false"}) or []
    picked = []
    for m in rows:
        q = (m.get("question") or "").lower()
        if not q or any(w in q for w in SPORT):
            continue
        toks = json.loads(m.get("clobTokenIds") or "[]")
        if toks:
            picked.append((m.get("question", ""), toks[0]))
        if len(picked) >= args.n:
            break

    print(f"[latency] sampling {len(picked)} news-sensitive markets (minute data)...\n")
    trans = []
    examples = []
    for q, tok in picked:
        h = minute_history(tok)
        r = largest_move_transition(h)
        time.sleep(0.1)
        if r is None:
            continue
        move, tmin = r
        trans.append(tmin)
        examples.append((tmin, move, q))

    if not trans:
        print("no markets with a measurable move found.")
        return
    trans.sort()
    examples.sort()
    print(f"markets with a >8c move: {len(trans)}")
    print(f"TRANSITION TIME (min, 10%->90% of the move):")
    print(f"  median = {statistics.median(trans):.1f} min")
    print(f"  25th/75th pct = {trans[len(trans)//4]:.1f} / {trans[3*len(trans)//4]:.1f} min")
    print(f"  share completing in <2 min  (ungrabbable) : {sum(t<2 for t in trans)/len(trans):.0%}")
    print(f"  share taking   >15 min (grabbable)        : {sum(t>15 for t in trans)/len(trans):.0%}")
    print("\nfastest (gap-like) moves:")
    for tmin, mv, q in examples[:4]:
        print(f"  {tmin:5.1f}min  move={mv:.2f}  {q[:55]}")
    print("slowest (grindy) moves:")
    for tmin, mv, q in examples[-4:]:
        print(f"  {tmin:5.1f}min  move={mv:.2f}  {q[:55]}")
    print("\nInterpretation: the slow-grind share is where a news monitor can act")
    print("before the crowd finishes repricing. Gap-like moves are already gone.")


if __name__ == "__main__":
    main()
