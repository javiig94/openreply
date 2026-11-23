#!/usr/bin/env python3
"""Grid / pendulum backtester on real crypto OHLC (Kraken, free, keyless).

Reconstructs the "pendulum" a trader described: quote levels around a center;
buy when price crosses a level DOWN, sell when it crosses one UP, harvesting
each oscillation. Optional DCA (no cap) = the dangerous averaging-down that
makes the equity curve pretty until a trend liquidates it.

The whole point is to measure what naive grid backtests hide: **max drawdown
and ruin in trending regimes**, not just the average return in a range.

  python gridbot.py --pair XBTUSD --interval 1440 --spacing 0.03 --levels 10
  python gridbot.py --pair XBTUSD --interval 60 --spacing 0.01 --levels 20 --dca
"""
from __future__ import annotations
import argparse
import json
import os
import time
import requests

DATA = os.path.join(os.path.dirname(__file__), "data")
KRAKEN = "https://api.kraken.com/0/public/OHLC"


def fetch_ohlc(pair: str, interval: int, refresh: bool = False):
    os.makedirs(DATA, exist_ok=True)
    path = os.path.join(DATA, f"{pair}_{interval}.json")
    if os.path.exists(path) and not refresh:
        return json.load(open(path))
    last = None
    for i in range(4):
        try:
            r = requests.get(KRAKEN, params={"pair": pair, "interval": interval}, timeout=30)
            r.raise_for_status()
            res = r.json()["result"]
            key = [k for k in res if k != "last"][0]
            rows = [(int(c[0]), float(c[1]), float(c[2]), float(c[3]), float(c[4]))
                    for c in res[key]]
            json.dump(rows, open(path, "w"))
            return rows
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"Kraken fetch failed: {last}")


class GridBot:
    """Static grid over [center*(1-R), center*(1+R)] with N levels each side.

    Buy `size` (quote $) of base when price crosses a level downward; sell it
    back one level up (locking `spacing` return on that lot). Inventory grows
    when price trends down through many levels — that is the risk the test
    exposes.
    """
    def __init__(self, center, spacing, levels, size, capital, dca, cap_mult, fee=0.0):
        self.center = center
        self.spacing = spacing
        self.levels = levels                      # max grid depth when NOT dca
        self.size = size
        self.cash = capital
        self.capital0 = capital
        self.dca = dca
        self.fee = fee                            # per-fill cost, fraction of notional
        self.fees_paid = 0.0
        self.cap_inventory = capital * cap_mult
        # price of the k-th buy level below center (k>=1), arithmetic grid
        self.lots = {}            # k -> (entry_price, base_qty) ; one open lot per level
        self.realized = 0.0
        self.trades = 0
        self.peak_equity = capital
        self.max_dd = 0.0
        self.blew_up = False

    def buy_price(self, k):
        return self.center * (1 - self.spacing * k)

    def _inventory_value(self, price):
        return sum(q * price for _, q in self.lots.values())

    def step(self, o, h, l, c):
        # BUY: fill every empty level k whose price >= candle low.
        # k runs 1..levels (capped) or 1..infinity (dca, until low is covered).
        k = 1
        while True:
            lvl = self.buy_price(k)
            if lvl <= 0:
                break
            if not self.dca and k > self.levels:
                break
            if lvl < l:                           # candle never reached this level
                break
            if k not in self.lots:
                inv = self._inventory_value(lvl)
                if not self.dca and inv >= self.cap_inventory:
                    k += 1
                    continue
                qty = self.size / lvl
                self.cash -= qty * lvl            # cash can go negative in dca = leverage/ruin
                fee = qty * lvl * self.fee
                self.cash -= fee
                self.fees_paid += fee
                self.lots[k] = (lvl, qty)
                self.trades += 1
            k += 1
        # SELL: close any lot whose +1-spacing target is within the candle high.
        for kk in sorted(list(self.lots)):
            ep, q = self.lots[kk]
            target = ep * (1 + self.spacing)
            if h >= target:
                fee = q * target * self.fee
                self.cash += q * target - fee
                self.fees_paid += fee
                self.realized += q * (target - ep) - fee
                self.trades += 1
                del self.lots[kk]
        equity = self.cash + self._inventory_value(c)
        self.peak_equity = max(self.peak_equity, equity)
        dd = (self.peak_equity - equity) / self.peak_equity if self.peak_equity > 0 else 1.0
        self.max_dd = max(self.max_dd, dd)
        if equity <= 0.05 * self.capital0:
            self.blew_up = True
        return equity

    def run(self, candles):
        eq = self.capital0
        for (_, o, h, l, c) in candles:
            eq = self.step(o, h, l, c)
            if self.blew_up:
                break
        final_price = candles[-1][4]
        equity = self.cash + self._inventory_value(final_price)
        return {
            "final_equity": equity,
            "return": equity / self.capital0 - 1,
            "realized_pnl": self.realized,
            "open_inventory_$": self._inventory_value(final_price),
            "open_lots": len(self.lots),
            "trades": self.trades,
            "max_drawdown": self.max_dd,
            "blew_up": self.blew_up,
            "fees_paid": self.fees_paid,
        }


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--pair", default="XBTUSD")
    ap.add_argument("--interval", type=int, default=1440, help="minutes: 60=hourly 1440=daily")
    ap.add_argument("--spacing", type=float, default=0.03, help="grid step (0.03 = 3%)")
    ap.add_argument("--levels", type=int, default=10)
    ap.add_argument("--size", type=float, default=100.0, help="$ per grid fill")
    ap.add_argument("--capital", type=float, default=10000.0)
    ap.add_argument("--dca", action="store_true", help="no inventory cap (dangerous)")
    ap.add_argument("--cap-mult", type=float, default=0.5, help="max long = capital*this (non-dca)")
    ap.add_argument("--fee", type=float, default=0.0,
                    help="per-fill fee fraction (0.0002 maker, 0.001 taker)")
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()

    candles = fetch_ohlc(args.pair, args.interval, args.refresh)
    import datetime as dt
    d0 = dt.datetime.fromtimestamp(candles[0][0], dt.timezone.utc).date()
    d1 = dt.datetime.fromtimestamp(candles[-1][0], dt.timezone.utc).date()
    p0, p1 = candles[0][4], candles[-1][4]
    center = sum(c[4] for c in candles) / len(candles)
    bh = p1 / p0 - 1

    bot = GridBot(center, args.spacing, args.levels, args.size,
                  args.capital, args.dca, args.cap_mult, args.fee)
    r = bot.run(candles)

    print(f"\n{args.pair} {args.interval}m  {d0}..{d1}  ({len(candles)} candles)")
    print(f"price {p0:,.0f} -> {p1:,.0f}  (buy&hold {bh:+.1%})   grid center {center:,.0f}")
    print(f"config: spacing={args.spacing:.1%} levels={args.levels} size=${args.size:.0f} "
          f"dca={'ON' if args.dca else 'off'} cap={args.cap_mult}x")
    print("-" * 56)
    print(f" final equity   : ${r['final_equity']:,.0f}   return {r['return']:+.1%}")
    print(f" realized PnL   : ${r['realized_pnl']:,.0f}  ({r['trades']} trades, ${r['fees_paid']:,.0f} fees)")
    print(f" open inventory : ${r['open_inventory_$']:,.0f}  ({r['open_lots']} lots stuck)")
    print(f" MAX DRAWDOWN   : {r['max_drawdown']:.1%}")
    print(f" blew up (<5%)  : {'YES — ACCOUNT RUINED' if r['blew_up'] else 'no'}")
    print("-" * 56)
    verdict = ("grid > buy&hold" if r["return"] > bh else "buy&hold wins")
    print(f" vs buy&hold {bh:+.1%}: {verdict}")
    print(" NB: realized PnL looks clean, but read MAX DRAWDOWN + stuck inventory.")
    print(" That is where a trend turns 'steady gains' into ruin. No fees/funding modelled.")


if __name__ == "__main__":
    main()
