"""Polymarket access: temperature events, resolution, and price history.

APIs (public, keyless):
  - gamma-api.polymarket.com/events?slug=...   -> event + bucket markets
  - clob.polymarket.com/prices-history          -> YES price time series
"""
from __future__ import annotations
import json
import time
from dataclasses import dataclass, field
import requests

from .buckets import Bucket, parse_edges

_GAMMA = "https://gamma-api.polymarket.com"
_CLOB = "https://clob.polymarket.com"

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "polyweather-backtester/0.1 (research)"


def _get(url: str, params: dict | None = None, tries: int = 4):
    last = None
    for i in range(tries):
        try:
            r = _SESSION.get(url, params=params, timeout=40)
            if r.status_code == 429:
                time.sleep(2 * (i + 1))
                continue
            r.raise_for_status()
            return r.json()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise RuntimeError(f"Polymarket request failed ({url}): {last}")


@dataclass
class Event:
    slug: str
    title: str
    closed: bool
    end_ts: int                 # unix seconds of endDate (resolution/close)
    buckets: list[Bucket] = field(default_factory=list)

    @property
    def resolved_bucket(self) -> Bucket | None:
        for b in self.buckets:
            if b.resolved_yes:
                return b
        return None


def _iso_to_ts(iso: str) -> int:
    # endDate like "2025-06-01T12:00:00Z"
    import datetime as dt
    iso = iso.replace("Z", "+00:00")
    return int(dt.datetime.fromisoformat(iso).timestamp())


def fetch_event(slug: str) -> Event | None:
    data = _get(f"{_GAMMA}/events", {"slug": slug})
    if not data:
        return None
    e = data[0]
    buckets: list[Bucket] = []
    for m in e.get("markets", []):
        title = m.get("groupItemTitle") or m.get("question") or ""
        try:
            low, high = parse_edges(title)
        except ValueError:
            continue
        toks = json.loads(m.get("clobTokenIds") or "[]")
        prices = json.loads(m.get("outcomePrices") or "[]")
        yes_token = toks[0] if toks else ""
        resolved_yes = bool(prices) and float(prices[0]) >= 0.5
        buckets.append(Bucket(title=title, low=low, high=high,
                              yes_token=yes_token, resolved_yes=resolved_yes))
    buckets.sort(key=lambda b: b.midpoint)
    return Event(
        slug=e.get("slug", slug),
        title=e.get("title", ""),
        closed=bool(e.get("closed")),
        end_ts=_iso_to_ts(e["endDate"]) if e.get("endDate") else 0,
        buckets=buckets,
    )


def price_history(token_id: str, start_ts: int, end_ts: int,
                  fidelity: int = 60) -> list[tuple[int, float]]:
    """YES price series as [(unix_ts, price), ...] within [start_ts, end_ts]."""
    if not token_id:
        return []
    d = _get(f"{_CLOB}/prices-history", {
        "market": token_id, "startTs": start_ts, "endTs": end_ts,
        "fidelity": fidelity,
    })
    return [(int(p["t"]), float(p["p"])) for p in d.get("history", [])]


def price_at(token_id: str, as_of_ts: int, window_ts: int, lookback: int = 86400) -> float | None:
    """Last traded YES price at or before `as_of_ts` (within lookback)."""
    hist = price_history(token_id, as_of_ts - lookback, window_ts)
    prior = [p for (t, p) in hist if t <= as_of_ts]
    return prior[-1] if prior else None


def market_distribution(event: Event, as_of_ts: int) -> dict[str, float] | None:
    """Normalised market-implied probability per bucket at decision time.

    Reads each YES bucket's last price <= as_of_ts and renormalises so the
    buckets sum to 1 (they partition the outcome space).
    """
    raw: dict[str, float] = {}
    for b in event.buckets:
        p = price_at(b.yes_token, as_of_ts, event.end_ts)
        if p is None:
            continue
        raw[b.title] = max(0.0, min(1.0, p))
    s = sum(raw.values())
    if s <= 0:
        return None
    return {k: v / s for k, v in raw.items()}
