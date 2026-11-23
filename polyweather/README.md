# polyweather

An **honest backtester** for Polymarket daily-temperature markets. It answers one
question before you risk a cent: *does a calibrated weather forecast actually
beat the market's prices, out-of-sample?*

This is the research tool from the "Shenzhen kid makes $67k on autopilot" tweet,
stripped of the hype. It does **not** copy-trade wallets and it does **not** place
orders. It measures edge.

## What it does

1. **Discovers** resolved temperature events for a city over a date window
   (Polymarket Gamma API).
2. **Calibrates** a forecast-error model (`bias`, `sigma`) on a *training* slice.
   The target is the market's own resolved bucket, so the station-vs-gridded
   offset is absorbed into `bias`.
3. **Tests** on a held-out slice: at a fixed decision lead before close, it
   compares the model's bucket probabilities against the market's prices
   (multiclass **Brier score**) and simulates **fractional-Kelly** PnL on the edge.

No look-ahead: calibration uses only dates before the test slice, and the market
price is read at `close − lead_hours`.

## Install

```bash
pip install -r requirements.txt
```

All data sources are **free and keyless** (Open-Meteo + Polymarket public APIs).

## Backtest

```bash
python run_backtest.py --city london --start 2025-05-01 --end 2025-09-30 \
    --train-frac 0.5 --lead 24 --edge 0.07 --kelly 0.25
```

Reads: `brier_model` vs `brier_market` (lower is better). If the model's Brier
is not clearly below the market's on a large sample, **there is no edge** — stop.

## Live scan (paper, read-only)

Plug the `bias`/`sigma` you got from the backtest into the forward scanner. It
uses the live 31-member GFS ensemble and prints where the model disagrees with
current prices.

```bash
python scan_live.py --city london --date 2026-11-24 --bias 1.9 --sigma 2.1 --edge 0.07
```

## Honest limitations (read these)

- **No historical ensemble on the free tier.** Open-Meteo keeps individual
  members only ~3 days, so the backtest uses the archived *deterministic*
  forecast + a calibrated Gaussian, not a true 31-member historical spread. A
  real multi-lead ensemble backtest needs a paid archive or self-hosted GFS/GEFS.
- **Slippage is not modelled.** These books are thin ($20k–$190k/day per city,
  and much less per bucket). A positive simulated ROI means "edge exists at the
  quoted price", **not** "you can fill size at that price". Check order-book depth.
- **Resolution station matters.** Each contract names its own station/source.
  `config.py` uses airport coordinates; verify per contract before trading live.
- **Small samples lie.** Judge on a full season, not a week. Longshot buckets
  make ROI extremely high-variance at low trade counts.
- **ERA5 ≠ the paying station.** We found London's resolved max running ~2°F
  above ERA5 — that's the calibration bias at work, and why we score against the
  market's resolution, not reanalysis.

## Layout

```
polyweather/
  config.py       cities + resolution-station coords/units
  openmeteo.py    archived forecast, ensemble, ERA5 actuals
  polymarket.py   events, buckets, resolution, CLOB price history
  buckets.py      parse "64-65°F" style titles into numeric edges
  model.py        forecast -> calibrated bucket distribution (MOS)
  discover.py     slug generation + event discovery
  backtest.py     engine: calibrate, test, Brier, Kelly PnL
run_backtest.py   backtest CLI
scan_live.py      forward/paper scanner CLI
```

Research tool. Not financial advice. Prediction markets are restricted or
illegal in some jurisdictions — that's on you.
