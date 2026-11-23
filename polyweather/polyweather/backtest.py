"""Backtest engine: does a calibrated forecast beat the market, out-of-sample?

Pipeline per city over a date window:
  1. discover resolved temperature events
  2. CALIBRATE bias/sigma on a training slice (residual = realized - forecast),
     where `realized` is the market's own resolved-bucket midpoint (ground truth
     that already includes the resolution station's bias)
  3. TEST on a held-out slice: at a fixed decision lead before close, compare
     model vs market probability distributions against the realized bucket
     (multiclass Brier) and simulate fractional-Kelly PnL on the edge.

No look-ahead: calibration uses only training dates strictly before the test
slice; the decision-time market price is read at (close - lead_hours).
"""
from __future__ import annotations
import datetime as dt
from dataclasses import dataclass, field

from . import openmeteo as om
from .config import City, get_city
from .discover import discover
from .model import Calibration, bucket_probs
from .polymarket import Event, market_distribution


def brier(dist: dict[str, float], winner_title: str) -> float:
    """Multiclass Brier score: sum (p_i - y_i)^2, y one-hot. Lower is better."""
    return sum((p - (1.0 if title == winner_title else 0.0)) ** 2
               for title, p in dist.items())


@dataclass
class Trade:
    date: str
    bucket: str
    model_p: float
    market_q: float
    edge: float
    stake: float
    won: bool
    pnl: float


@dataclass
class Result:
    city: str
    n_train: int
    n_test: int
    cal: Calibration
    brier_model: float = 0.0
    brier_market: float = 0.0
    brier_uniform: float = 0.0
    model_hit: float = 0.0        # argmax-model == winner rate
    market_hit: float = 0.0
    trades: list[Trade] = field(default_factory=list)
    bankroll_curve: list[float] = field(default_factory=list)

    @property
    def roi(self) -> float:
        staked = sum(t.stake for t in self.trades)
        pnl = sum(t.pnl for t in self.trades)
        return (pnl / staked) if staked > 0 else 0.0


def _realized_mid(ev: Event) -> float | None:
    rb = ev.resolved_bucket
    return rb.midpoint if rb else None


def _forecast_map(city: City, dates: list[str]) -> dict[str, float]:
    if not dates:
        return {}
    lo, hi = min(dates), max(dates)
    return om.archived_forecast_max(city.lat, city.lon, lo, hi, city.unit, city.tz)


def run(city_key: str, start: dt.date, end: dt.date, *,
        train_frac: float = 0.5, lead_hours: int = 24,
        edge_threshold: float = 0.07, kelly_frac: float = 0.25,
        max_stake: float = 100.0, verbose: bool = True) -> Result:
    city = get_city(city_key)
    if verbose:
        print(f"[discover] {city.label}  {start}..{end}")
    events = [e for e in discover(city_key, start, end, verbose=verbose)
              if e.closed and e.resolved_bucket and e.end_ts]
    events.sort(key=lambda e: e.end_ts)
    if len(events) < 4:
        raise RuntimeError(f"Too few resolved events ({len(events)}) to backtest.")

    split = max(1, int(len(events) * train_frac))
    train, test = events[:split], events[split:]

    # --- calibration (training residuals) ---
    tr_dates = [dt.datetime.utcfromtimestamp(e.end_ts).strftime("%Y-%m-%d") for e in train]
    tr_fc = _forecast_map(city, tr_dates)
    residuals: list[float] = []
    for e, dstr in zip(train, tr_dates):
        fc = tr_fc.get(dstr)
        realized = _realized_mid(e)
        if fc is not None and realized is not None:
            residuals.append(realized - fc)
    cal = Calibration.fit(residuals)
    if verbose:
        print(f"[calibrate] n={cal.n}  bias={cal.bias:+.2f}{city.unit[0].upper()}  "
              f"sigma={cal.sigma:.2f}")

    res = Result(city=city.label, n_train=len(train), n_test=len(test), cal=cal)

    # --- test (out-of-sample) ---
    te_dates = [dt.datetime.utcfromtimestamp(e.end_ts).strftime("%Y-%m-%d") for e in test]
    te_fc = _forecast_map(city, te_dates)
    bankroll = 1000.0
    bm = bk = bu = 0.0
    mh = kh = 0
    scored = 0
    for e, dstr in zip(test, te_dates):
        fc = te_fc.get(dstr)
        if fc is None:
            continue
        winner = e.resolved_bucket.title
        model = bucket_probs(fc, e.buckets, cal)
        as_of = e.end_ts - lead_hours * 3600
        market = market_distribution(e, as_of)
        if market is None:
            continue
        # align keys (buckets present in both)
        titles = [b.title for b in e.buckets]
        model = {t: model.get(t, 0.0) for t in titles}
        market = {t: market.get(t, 0.0) for t in titles}
        sm = sum(market.values())
        if sm <= 0:
            continue
        market = {t: v / sm for t, v in market.items()}
        uniform = {t: 1.0 / len(titles) for t in titles}

        bm += brier(model, winner)
        bk += brier(market, winner)
        bu += brier(uniform, winner)
        mh += int(max(model, key=model.get) == winner)
        kh += int(max(market, key=market.get) == winner)
        scored += 1

        # --- edge bets ---
        for t in titles:
            p, q = model[t], market[t]
            if q <= 0.01 or q >= 0.99:
                continue
            edge = p - q
            if edge <= edge_threshold:
                continue
            f = max(0.0, (p - q) / (1.0 - q)) * kelly_frac
            stake = min(bankroll * f, max_stake)
            if stake < 1.0:
                continue
            won = (t == winner)
            pnl = stake * ((1.0 - q) / q) if won else -stake
            bankroll += pnl
            res.trades.append(Trade(dstr, t, p, q, edge, stake, won, pnl))
        res.bankroll_curve.append(bankroll)

    if scored:
        res.brier_model = bm / scored
        res.brier_market = bk / scored
        res.brier_uniform = bu / scored
        res.model_hit = mh / scored
        res.market_hit = kh / scored
    res.n_test = scored
    return res
