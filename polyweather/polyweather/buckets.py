"""Parse Polymarket temperature bucket titles into numeric edges.

Handles the three shapes Polymarket uses, in °F or °C:
  "63°F or below"   -> (-inf, 63]      (interpreted as < 64, i.e. high edge 63.5)
  "64-65°F"         -> (63.5, 65.5]
  "74°F or higher"  -> (73.5, +inf)

Buckets are integer-width; we place half-open edges at the .5 midpoints so the
whole real line is covered exactly once (a partition), which is what the
distribution integration needs.
"""
from __future__ import annotations
import re
from dataclasses import dataclass

INF = float("inf")


@dataclass(frozen=True)
class Bucket:
    title: str
    low: float          # exclusive lower edge
    high: float         # inclusive upper edge
    yes_token: str      # CLOB token id for the YES outcome
    resolved_yes: bool  # did this bucket win (from outcomePrices)

    @property
    def midpoint(self) -> float:
        if self.low == -INF:
            return self.high - 0.5
        if self.high == INF:
            return self.low + 0.5
        return (self.low + self.high) / 2.0

    def contains(self, temp: float) -> bool:
        return self.low < temp <= self.high


_NUM = r"(-?\d+(?:\.\d+)?)"
_RE_BELOW = re.compile(rf"{_NUM}\s*°?[FC]?\s*or\s*below", re.I)
_RE_HIGHER = re.compile(rf"{_NUM}\s*°?[FC]?\s*or\s*(?:higher|above)", re.I)
_RE_RANGE = re.compile(rf"{_NUM}\s*[-–]\s*{_NUM}\s*°?[FC]?", re.I)
_RE_SINGLE = re.compile(rf"^{_NUM}\s*°?[FC]?$", re.I)


def parse_edges(title: str) -> tuple[float, float]:
    """Return (low_exclusive, high_inclusive) for a bucket title."""
    t = title.strip()
    m = _RE_BELOW.search(t)
    if m:
        v = float(m.group(1))
        return (-INF, v + 0.5)   # "63 or below" == max <= 63  -> high edge 63.5
    m = _RE_HIGHER.search(t)
    if m:
        v = float(m.group(1))
        return (v - 0.5, INF)    # "74 or higher" -> low edge 73.5
    m = _RE_RANGE.search(t)
    if m:
        a, b = float(m.group(1)), float(m.group(2))
        lo, hi = min(a, b), max(a, b)
        return (lo - 0.5, hi + 0.5)
    m = _RE_SINGLE.search(t)
    if m:
        v = float(m.group(1))
        return (v - 0.5, v + 0.5)
    raise ValueError(f"Cannot parse bucket title: {title!r}")
