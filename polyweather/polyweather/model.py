"""Forecast -> calibrated bucket probability distribution.

Model: realized_max ~ Normal(forecast_max + bias, sigma), where bias and sigma
are fit from historical (forecast, realized) residuals for the station. This is
a simple Model-Output-Statistics (MOS) correction. The station-vs-grid offset
between the forecast source and Polymarket's resolution station is absorbed by
`bias`; day-to-day forecast uncertainty by `sigma`.

P(bucket) = Phi((high - mu)/sigma) - Phi((low - mu)/sigma).
"""
from __future__ import annotations
import math
from dataclasses import dataclass

from .buckets import Bucket, INF


def normal_cdf(x: float, mu: float = 0.0, sigma: float = 1.0) -> float:
    if sigma <= 0:
        return 1.0 if x >= mu else 0.0
    return 0.5 * (1.0 + math.erf((x - mu) / (sigma * math.sqrt(2.0))))


@dataclass
class Calibration:
    bias: float          # systematic (forecast + bias ~ realized)
    sigma: float         # residual std dev
    n: int               # training sample size

    @classmethod
    def fit(cls, residuals: list[float], floor_sigma: float = 1.0) -> "Calibration":
        """residuals = [realized - forecast] over a training window."""
        n = len(residuals)
        if n == 0:
            return cls(bias=0.0, sigma=3.0, n=0)
        bias = sum(residuals) / n
        if n >= 2:
            var = sum((r - bias) ** 2 for r in residuals) / (n - 1)
            sigma = max(math.sqrt(var), floor_sigma)
        else:
            sigma = 3.0
        return cls(bias=bias, sigma=sigma, n=n)


def blend(forecasts: dict[str, float], weights: dict[str, float] | None = None) -> float:
    """Weighted mean of per-model forecasts (equal weights by default)."""
    if not forecasts:
        raise ValueError("no forecasts to blend")
    if weights:
        num = sum(forecasts[m] * weights.get(m, 0.0) for m in forecasts)
        den = sum(weights.get(m, 0.0) for m in forecasts)
        if den > 0:
            return num / den
    return sum(forecasts.values()) / len(forecasts)


def multimodel_probs(forecasts: dict[str, float], buckets: list[Bucket],
                     cal: Calibration,
                     weights: dict[str, float] | None = None) -> dict[str, float]:
    """Predictive distribution treating each model as a kernel.

    Each model forecast is a Gaussian of width `cal.sigma` centred at
    (forecast + cal.bias); the mixture is the mean of those kernels. Inter-model
    disagreement widens the mixture automatically, which is the whole point:
    when GFS/ECMWF/ICON diverge, uncertainty is genuinely higher.
    """
    mu_shift = cal.bias
    sig = cal.sigma
    ws = weights or {m: 1.0 for m in forecasts}
    wsum = sum(ws.get(m, 0.0) for m in forecasts) or 1.0
    out: dict[str, float] = {}
    for b in buckets:
        acc = 0.0
        for m, val in forecasts.items():
            mu = val + mu_shift
            lo = 0.0 if b.low == -INF else normal_cdf(b.low, mu, sig)
            hi = 1.0 if b.high == INF else normal_cdf(b.high, mu, sig)
            acc += ws.get(m, 0.0) * (hi - lo)
        out[b.title] = acc / wsum
    s = sum(out.values())
    return {k: v / s for k, v in out.items()} if s > 0 else out


def bucket_probs(forecast_max: float, buckets: list[Bucket],
                 cal: Calibration) -> dict[str, float]:
    """Calibrated probability for each bucket given a deterministic forecast."""
    mu = forecast_max + cal.bias
    sig = cal.sigma
    out: dict[str, float] = {}
    for b in buckets:
        lo = 0.0 if b.low == -INF else normal_cdf(b.low, mu, sig)
        hi = 1.0 if b.high == INF else normal_cdf(b.high, mu, sig)
        out[b.title] = max(0.0, hi - lo)
    s = sum(out.values())
    if s > 0:
        out = {k: v / s for k, v in out.items()}
    return out
