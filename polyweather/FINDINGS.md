# Findings

## Experiment 1 — London (Heathrow), May–Sep 2025

Out-of-sample backtest, 75 test events, calibrated deterministic GFS forecast
(Open-Meteo archived) vs Polymarket prices. Calibration: `bias=+0.82°F`,
`sigma=2.08`.

### Does the model beat the market, across decision leads?

| lead (h) | n  | Brier model | Brier market | diff      | model hit | market hit | ROI (sim) |
|---------:|---:|------------:|-------------:|----------:|----------:|-----------:|----------:|
| 24       | 75 | 0.6962      | 0.6996       | **+0.0034** | 41.3%   | 42.7%      | +108.2%   |
| 6        | 75 | 0.6962      | 0.6222       | **−0.0740** | 41.3%   | 50.7%      | +36.4%    |
| 3        | 75 | 0.6962      | 0.5738       | **−0.1224** | 41.3%   | 56.0%      | −3.8%     |

`diff = Brier_market − Brier_model`; positive = model better.

### Conclusion

**No exploitable edge from a deterministic public forecast.**

The market *converges* as resolution approaches — its Brier falls 0.70 → 0.62 →
0.57 and its argmax hit-rate climbs 42.7% → 50.7% → 56.0%. The model is static
(same forecast, Brier 0.6962 at every lead). So:

- At **24h** the model looks level with the market — but only because the market
  is still immature. You are beating an unformed book, not the market.
- By **6h and 3h** the sharp market clearly **beats** the model.
- The headline **+108% simulated ROI at 24h is a mirage**: it comes from a few
  winning longshot buckets (high variance), and it **collapses to −3.8%** once
  the market is sharp. The Brier near-tie, not the ROI, was the honest signal.

This is the opposite of the "autopilot prints money" tweet. Public forecast
information is already in the price. To find real edge you need information the
market lacks — a better model (ECMWF, multi-model ensemble), a genuine
microstructure/speed edge at short lead, or thinner books (where slippage then
eats you).

### Next experiments

1. Add **ECMWF** (and a GFS+ECMWF blend) to `model.py` — the most likely source
   of a Brier improvement over the market.
2. Use the **live 31-member ensemble spread** (`scan_live.py`) instead of a
   Gaussian around the deterministic mean; test whether the spread is better
   calibrated than the price at short lead.
3. Repeat on **lower-volume cities** and measure order-book depth to quantify the
   slippage-vs-edge trade-off honestly.
