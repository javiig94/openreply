#!/usr/bin/env python3
"""Strategy research harness: find an actually-winning angle (or prove none).

Collects each event's data ONCE (multi-model forecasts, resolution, full price
history for every bucket) and caches it to data/<city>_<range>.json, then runs
three analyses in memory:

  A. MULTI-MODEL skill vs market across decision leads
     (does a GFS+ECMWF+ICON blend beat the market at any lead?)
  B. CONVERGENCE trading
     (enter where model disagrees at a long lead, exit at a short lead as the
      market converges toward truth — profit without beating the sharp market)
  C. INTRA-EVENT ARBITRAGE
     (do the YES bucket prices sum to != 1? model-free edge if they do)

Usage:
  python research.py --city london --start 2025-05-01 --end 2025-09-30
  python research.py --city nyc --start 2025-06-01 --end 2025-08-31 --refresh
"""
from __future__ import annotations
import argparse
import datetime as dt
import json
import os

from polyweather import openmeteo as om
from polyweather.config import get_city, CITIES
from polyweather.discover import slug_for
from polyweather.polymarket import fetch_event, price_history
from polyweather.model import Calibration, multimodel_probs, blend
from polyweather.backtest import brier

MODELS = ["gfs_seamless", "ecmwf_ifs025", "icon_seamless"]
DATA_DIR = os.path.join(os.path.dirname(__file__), "data")


# --------------------------------------------------------------------------- #
# Collection (cached)                                                          #
# --------------------------------------------------------------------------- #
def collect(city_key: str, start: dt.date, end: dt.date, refresh: bool) -> list[dict]:
    os.makedirs(DATA_DIR, exist_ok=True)
    tag = f"{city_key}_{start}_{end}"
    path = os.path.join(DATA_DIR, f"{tag}.json")
    if os.path.exists(path) and not refresh:
        with open(path) as f:
            ds = json.load(f)
        print(f"[cache] loaded {len(ds)} events from {path}")
        return ds

    city = get_city(city_key)
    print(f"[collect] {city.label}  {start}..{end}  (models={','.join(MODELS)})")
    # one multi-model forecast request for the whole window
    fc_multi = om.archived_forecast_max_multi(
        city.lat, city.lon, start.isoformat(), end.isoformat(),
        city.unit, city.tz, MODELS)

    dataset: list[dict] = []
    d = start
    while d <= end:
        slug = slug_for(city_key, d)
        dstr = d.isoformat()
        try:
            ev = fetch_event(slug)
        except Exception as e:  # noqa: BLE001
            ev = None
            print(f"  ! {slug}: {e}")
        if ev and ev.buckets and ev.closed and ev.resolved_bucket and ev.end_ts:
            forecasts = {m: fc_multi.get(m, {}).get(dstr) for m in MODELS}
            forecasts = {m: v for m, v in forecasts.items() if v is not None}
            if forecasts:
                buckets = []
                for b in ev.buckets:
                    hist = price_history(b.yes_token, ev.end_ts - 5 * 86400, ev.end_ts, fidelity=60)
                    buckets.append({
                        "title": b.title, "low": b.low, "high": b.high,
                        "mid": b.midpoint, "resolved_yes": b.resolved_yes,
                        "history": hist,
                    })
                dataset.append({
                    "date": dstr, "slug": ev.slug, "end_ts": ev.end_ts,
                    "forecasts": forecasts, "buckets": buckets,
                    "winner": ev.resolved_bucket.title,
                    "winner_mid": ev.resolved_bucket.midpoint,
                })
                print(f"  + {dstr}  models={len(forecasts)}  winner={ev.resolved_bucket.title}")
        d += dt.timedelta(days=1)

    with open(path, "w") as f:
        json.dump(dataset, f)
    print(f"[collect] saved {len(dataset)} events -> {path}")
    return dataset


def price_at(hist: list, as_of_ts: int) -> float | None:
    prior = [p for (t, p) in hist if t <= as_of_ts]
    return prior[-1] if prior else None


def market_dist(ev: dict, as_of_ts: int) -> dict[str, float] | None:
    raw = {}
    for b in ev["buckets"]:
        p = price_at(b["history"], as_of_ts)
        if p is not None:
            raw[b["title"]] = max(0.0, min(1.0, p))
    s = sum(raw.values())
    return {k: v / s for k, v in raw.items()} if s > 0 else None


def raw_yes_sum(ev: dict, as_of_ts: int) -> float | None:
    """Unnormalised sum of YES prices across buckets (the 'overround' probe)."""
    vals = []
    for b in ev["buckets"]:
        p = price_at(b["history"], as_of_ts)
        if p is not None:
            vals.append(p)
    return sum(vals) if len(vals) == len(ev["buckets"]) else None


# --------------------------------------------------------------------------- #
# Calibration                                                                  #
# --------------------------------------------------------------------------- #
def fit_cal(train: list[dict], weights=None) -> Calibration:
    res = []
    for ev in train:
        b = blend(ev["forecasts"], weights)
        res.append(ev["winner_mid"] - b)
    return Calibration.fit(res)


class Buckets:
    """Lightweight bucket adapter so model fns can read cached dicts."""
    def __init__(self, bdicts):
        self._b = bdicts
    def __iter__(self):
        from polyweather.buckets import Bucket
        for b in self._b:
            yield Bucket(b["title"], b["low"], b["high"], "", b["resolved_yes"])


# --------------------------------------------------------------------------- #
# A. Multi-model skill vs market across leads                                  #
# --------------------------------------------------------------------------- #
def analysis_multimodel(dataset, leads, train_frac=0.5, weights=None):
    dataset = sorted(dataset, key=lambda e: e["end_ts"])
    split = max(1, int(len(dataset) * train_frac))
    train, test = dataset[:split], dataset[split:]
    cal = fit_cal(train, weights)
    print(f"\n=== A. MULTI-MODEL vs MARKET ({'+'.join(m.split('_')[0] for m in MODELS)}) ===")
    print(f"calibration: bias={cal.bias:+.2f} sigma={cal.sigma:.2f} (n={cal.n})  test n={len(test)}")
    print(f"{'lead':>5} {'brier_mdl':>10} {'brier_mkt':>10} {'diff':>9} {'mdl_hit':>8} {'mkt_hit':>8}")
    print("-" * 56)
    rows = []
    for lead in leads:
        bm = bk = 0.0; mh = kh = 0; n = 0
        for ev in test:
            titles = [b["title"] for b in ev["buckets"]]
            model = multimodel_probs(ev["forecasts"], list(Buckets(ev["buckets"])), cal, weights)
            model = {t: model.get(t, 0.0) for t in titles}
            mkt = market_dist(ev, ev["end_ts"] - lead * 3600)
            if not mkt:
                continue
            mkt = {t: mkt.get(t, 0.0) for t in titles}
            w = ev["winner"]
            bm += brier(model, w); bk += brier(mkt, w)
            mh += int(max(model, key=model.get) == w)
            kh += int(max(mkt, key=mkt.get) == w)
            n += 1
        if n:
            rows.append((lead, bm/n, bk/n, mh/n, kh/n))
            print(f"{lead:>5} {bm/n:>10.4f} {bk/n:>10.4f} {bk/n-bm/n:>+9.4f} {mh/n:>7.1%} {kh/n:>7.1%}")
    return cal, rows


# --------------------------------------------------------------------------- #
# B. Convergence trading                                                       #
# --------------------------------------------------------------------------- #
def analysis_convergence(dataset, cal, l_in, l_out, edge_thr=0.05,
                         kelly_frac=0.25, max_stake=100.0, train_frac=0.5, weights=None):
    dataset = sorted(dataset, key=lambda e: e["end_ts"])
    split = max(1, int(len(dataset) * train_frac))
    test = dataset[split:]
    print(f"\n=== B. CONVERGENCE  enter@{l_in}h exit@{l_out}h  edge>{edge_thr:.0%} ===")
    bankroll = 1000.0
    n_tr = n_win = 0
    pnl_exit = pnl_hold = staked = 0.0
    for ev in test:
        titles = [b["title"] for b in ev["buckets"]]
        model = multimodel_probs(ev["forecasts"], list(Buckets(ev["buckets"])), cal, weights)
        din = market_dist(ev, ev["end_ts"] - l_in * 3600)
        if not din:
            continue
        for b in ev["buckets"]:
            t = b["title"]
            q_in = price_at(b["history"], ev["end_ts"] - l_in * 3600)
            q_out = price_at(b["history"], ev["end_ts"] - l_out * 3600)
            if q_in is None or q_out is None or q_in <= 0.01 or q_in >= 0.99:
                continue
            p = model.get(t, 0.0)
            edge = p - (din.get(t, 0.0))
            if edge <= edge_thr:
                continue
            f = max(0.0, edge / (1.0 - q_in)) * kelly_frac
            stake = min(bankroll * f, max_stake)
            if stake < 1.0:
                continue
            shares = stake / q_in
            # exit: sell at q_out (convergence capture, mark-to-market)
            pe = shares * (q_out - q_in)
            # hold: settle at resolution
            won = (t == ev["winner"])
            ph = shares * ((1.0 - q_in) if won else -q_in)
            pnl_exit += pe; pnl_hold += ph; staked += stake
            bankroll += pe
            n_tr += 1; n_win += int(won)
    if staked > 0:
        print(f"trades={n_tr} (settle-winners {n_win})  staked={staked:,.0f}")
        print(f"  EXIT@{l_out}h  PnL={pnl_exit:+,.0f}  ROI={pnl_exit/staked:+.1%}  (capture the convergence)")
        print(f"  HOLD->settle  PnL={pnl_hold:+,.0f}  ROI={pnl_hold/staked:+.1%}")
    else:
        print("no qualifying trades")


# --------------------------------------------------------------------------- #
# C. Intra-event arbitrage / overround                                        #
# --------------------------------------------------------------------------- #
def analysis_arbitrage(dataset, leads):
    print("\n=== C. INTRA-EVENT ARBITRAGE (sum of YES prices) ===")
    print(f"{'lead':>5} {'n':>4} {'mean_sum':>9} {'min':>6} {'max':>6} {'<0.97':>6} {'>1.03':>6}")
    print("-" * 46)
    for lead in leads:
        sums = []
        for ev in dataset:
            s = raw_yes_sum(ev, ev["end_ts"] - lead * 3600)
            if s is not None:
                sums.append(s)
        if not sums:
            continue
        under = sum(1 for s in sums if s < 0.97)
        over = sum(1 for s in sums if s > 1.03)
        print(f"{lead:>5} {len(sums):>4} {sum(sums)/len(sums):>9.3f} "
              f"{min(sums):>6.2f} {max(sums):>6.2f} {under:>6} {over:>6}")
    print("sum<1 at buy side => buying every bucket locks < $1 cost for $1 payout (arb).")


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--city", default="london", choices=list(CITIES))
    ap.add_argument("--start", type=lambda s: dt.datetime.strptime(s, "%Y-%m-%d").date(), required=True)
    ap.add_argument("--end", type=lambda s: dt.datetime.strptime(s, "%Y-%m-%d").date(), required=True)
    ap.add_argument("--refresh", action="store_true", help="re-download (ignore cache)")
    ap.add_argument("--leads", type=int, nargs="+", default=[48, 24, 12, 6, 3])
    args = ap.parse_args()

    ds = collect(args.city, args.start, args.end, args.refresh)
    if len(ds) < 8:
        print(f"only {len(ds)} events; need more for signal.")
        return

    # equal-weight and ECMWF-tilted blends
    cal, _ = analysis_multimodel(ds, args.leads)
    analysis_convergence(ds, cal, l_in=24, l_out=3)
    analysis_arbitrage(ds, args.leads)


if __name__ == "__main__":
    main()
