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

## Experiment 2 — four strategies, London May–Sep 2025 (150 events)

Ran `research.py` (multi-model) + live order-book probes + `nowcast.py`.

### A. Multi-model (GFS+ECMWF+ICON) skill vs market, by lead

| lead | Brier model | Brier market | diff | model hit | market hit |
|-----:|------------:|-------------:|-----:|----------:|-----------:|
| 48h  | 0.6930 | 0.7747 | +0.082 | 42.3% | 30.8% |
| 24h  | 0.6945 | 0.6996 | +0.005 | 41.3% | 42.7% |
| 12h  | 0.6945 | 0.6175 | −0.077 | 41.3% | 58.7% |
| 3h   | 0.6945 | 0.5738 | −0.121 | 41.3% | 56.0% |

**Adding ECMWF did not help.** Same shape as GFS-alone: the model only "wins"
at 48h (immature market) and the sharp market crushes it by 3h. Public forecast
skill is priced in. **Dead end.**

### B. Convergence (enter 24h on disagreement, exit 3h)

Backtest showed +66% (exit) / +84% (hold) ROI — **not trusted.** It is built on
cached *last-trade* prices, which Experiment C proved unreliable, and rests on
~111 highly-correlated bets (adjacent buckets, autocorrelated weather) = few
independent samples. **Unvalidated; treat as noise until reproduced on
executable quotes across multiple cities/seasons.**

### C. Intra-event arbitrage (overround) — killed by the live book

Cached last-trade prices summed to 1.08–1.25 (looked like a fat overround to
fade). The **live order book says otherwise**: on a real market the cheapest
YES asks summed to **1.019** (~2% vig) and selling all YES collected 0.964 (you
*lose* 3.6% after paying the winner). The historical 1.25 was a **stale-price
artifact** of illiquid buckets whose last trade never updated. **No arb.**

### D. Nowcast ("read the thermometer") — right idea, wrong data

Concept: once the observed running max passes a bucket's top, that bucket is
mathematically dead; fade any laggard still quoting it. Sound in theory. But with
free **ERA5 gridded** observations it is unsafe: ERA5 vs the resolution station
has **MAE 1.87°F, std 2.25°F, max divergence 5.8°F** (hotter on 48/150 days,
cooler on 62/150). The screen flagged **46 "impossible" buckets that actually
won** — false positives that would lose money. **A real nowcast needs the exact
station's live METAR/Wunderground feed, not reanalysis.**

## Bottom line

This is a **near-efficient, bot-saturated** market. Across four angles:
forecast skill is priced in; the overround is a measurement mirage; convergence
is unvalidated noise on bad prices; the nowcast needs station-grade real-time
data the free tier can't supply. **No free, model-based edge survived contact
with real order books.** The viral "autopilot prints money" story does not
reproduce.

The only angle with a theoretical pulse: **real-time nowcasting against the
exact resolution station (METAR), in cities the incumbent bots have not
saturated** — a speed/infrastructure game, not a modelling game. Even then, a
live book we sampled (Seoul) was already sharp, i.e. someone is doing this.

### If pursued further (eyes open)
1. Wire the **station METAR feed** (free, real-time) for one city; re-run `nowcast.py`
   logic live against the order book, not cached last-trade.
2. Measure **executable** depth (best bid/ask, not last trade) on low-volume cities.
3. Account for fees + the ~2% vig in every P&L before believing any ROI.
