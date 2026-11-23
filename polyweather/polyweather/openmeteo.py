"""Open-Meteo data access: archived forecasts, ensemble, and actuals.

All endpoints are free and keyless for non-commercial use.
  - historical-forecast-api : archived model forecasts for past valid dates
  - ensemble-api            : live 31-member GFS ensemble (forward/paper mode)
  - archive-api             : ERA5 reanalysis "actuals" (proxy ground truth)

NOTE on honesty: the free tier does NOT archive individual ensemble members
for past dates (members are kept ~3 days). So backtests use the archived
*deterministic* forecast max plus a calibrated error distribution. The live
ensemble is only used in forward/paper mode. This limitation is real; a true
multi-lead ensemble backtest needs a paid archive or self-hosted GEFS/GFS.
"""
from __future__ import annotations
import time
import requests

_HIST_FC = "https://historical-forecast-api.open-meteo.com/v1/forecast"
_ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
_ENSEMBLE = "https://ensemble-api.open-meteo.com/v1/ensemble"

_SESSION = requests.Session()
_SESSION.headers["User-Agent"] = "polyweather-backtester/0.1 (research)"


def _get(url: str, params: dict, tries: int = 4) -> dict:
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
    raise RuntimeError(f"Open-Meteo request failed ({url}): {last}")


def archived_forecast_max(lat: float, lon: float, start: str, end: str,
                          unit: str, tz: str) -> dict[str, float]:
    """Archived deterministic forecast daily max temp, per valid date.

    Returns {date: max_temp}. This is the forecast Open-Meteo recorded for
    each past day (its native lead), used as the model's central estimate.
    """
    d = _get(_HIST_FC, {
        "latitude": lat, "longitude": lon,
        "start_date": start, "end_date": end,
        "daily": "temperature_2m_max",
        "temperature_unit": unit, "timezone": tz,
    })
    dd = d.get("daily", {})
    return {t: v for t, v in zip(dd.get("time", []), dd.get("temperature_2m_max", []))
            if v is not None}


def archived_forecast_max_multi(lat: float, lon: float, start: str, end: str,
                                unit: str, tz: str,
                                models: list[str]) -> dict[str, dict[str, float]]:
    """Archived deterministic daily max for several models at once.

    Returns {model_name: {date: max_temp}}. Open-Meteo suffixes each model's
    field as temperature_2m_max_<model> when multiple models are requested.
    """
    d = _get(_HIST_FC, {
        "latitude": lat, "longitude": lon,
        "start_date": start, "end_date": end,
        "daily": "temperature_2m_max",
        "models": ",".join(models),
        "temperature_unit": unit, "timezone": tz,
    })
    dd = d.get("daily", {})
    times = dd.get("time", [])
    out: dict[str, dict[str, float]] = {}
    for m in models:
        key = f"temperature_2m_max_{m}"
        series = dd.get(key)
        if series is None and len(models) == 1:
            series = dd.get("temperature_2m_max")
        if series is None:
            continue
        out[m] = {t: v for t, v in zip(times, series) if v is not None}
    return out


def actual_max(lat: float, lon: float, start: str, end: str,
               unit: str, tz: str) -> dict[str, float]:
    """ERA5 reanalysis daily max temp (proxy ground truth for calibration).

    WARNING: ERA5 is gridded reanalysis and can differ from the point station
    Polymarket resolves against by a few degrees. That station bias is exactly
    what the calibration bias term absorbs. For scoring, prefer the market's
    own resolved bucket (see polymarket.resolved_bucket)."""
    d = _get(_ARCHIVE, {
        "latitude": lat, "longitude": lon,
        "start_date": start, "end_date": end,
        "daily": "temperature_2m_max",
        "temperature_unit": unit, "timezone": tz,
    })
    dd = d.get("daily", {})
    return {t: v for t, v in zip(dd.get("time", []), dd.get("temperature_2m_max", []))
            if v is not None}


def live_ensemble_max(lat: float, lon: float, valid_date: str,
                      unit: str, tz: str) -> list[float]:
    """Live 31-member GFS ensemble: daily max for a (near-future) valid date.

    Returns a list of per-member max temps for `valid_date`. Only works for
    recent/future dates (forward/paper mode), not historical backtests.
    """
    d = _get(_ENSEMBLE, {
        "latitude": lat, "longitude": lon,
        "models": "gfs025",
        "hourly": "temperature_2m",
        "start_date": valid_date, "end_date": valid_date,
        "temperature_unit": unit, "timezone": tz,
    })
    h = d.get("hourly", {})
    times = h.get("time", [])
    member_keys = [k for k in h if k.startswith("temperature_2m")]
    out = []
    for k in member_keys:
        vals = [v for t, v in zip(times, h[k]) if v is not None and t.startswith(valid_date)]
        if vals:
            out.append(max(vals))
    return out
