# newsedge — real-time news → Polymarket signal monitor

The realistic "get ahead of the market on speed" play. You will **not** beat CEX
HFT on BTC (sub-second, co-located). But Polymarket's crowd reprices news
**slowly**, and that is measurable — so the edge is: spot a catalyst, find the
open market it resolves, act before the crowd finishes dragging the price.

## The key measurement (latency_study.py)

Sampled 70 news-sensitive active markets, minute-resolution price history, and
measured each market's largest move's **10%→90% transition time**:

```
markets with a >8c move      : 20
median transition            : 17.8 min
25th / 75th percentile       : 5.0 / 30.0 min
completes in <2 min (gap)    : 15%   <- unbeatable, already gone
takes >15 min (grind)        : 55%   <- a monitor can act inside this
```

**Polymarket takes a median ~18 minutes to finish a move** — an eternity vs a
CEX. That window is the whole opportunity.

### Honest nuance (don't over-read it)
- The slow-grind markets are disproportionately **continuous-variable** ones
  (“BTC reaches $70k”, “Elon posts 115-139 tweets”, “NVIDIA largest company”).
  They grind because the *underlying* moves gradually, not because the crowd is
  dumb — you can’t beat those with news speed, you’d need a better view of the
  variable itself.
- **Discrete-event** markets (a resignation, a ruling) are where news speed
  truly matters, and they reprice faster: the NVIDIA-CEO market moved in ~3 min.
  So the practical window for a true catalyst is **minutes, not 18** — tight but
  not zero.
- RSS is the bottleneck: the freshest headline we caught was already **~3 min
  old**. To capture discrete events you need faster sources than RSS (primary
  source pages, data feeds, social firehose).

## The monitor (newsedge.py + sources.py + direction.py)

Pipeline: pull **multiple sources** → match headline to open market by entity →
**infer the trade side** → alert with price, latency, side and confidence.

- **sources.py** — RSS (BBC world/biz/politics, CoinDesk, Fed) **+ Hacker News**
  (Algolia, one call, titled+timestamped, breaks tech/crypto fast). Hook left for
  SEC EDGAR / primary-source pollers.
- **match** — requires a shared multi-word proper noun (or two proper nouns), so
  loose overlap (“ai”, “french”) no longer fires.
- **direction.py** — detects the market’s event type (resignation, election,
  price-reach, approval, ceasefire, rate decision) and applies a polarity lexicon
  to the headline, handling question-negation and explicit denials. Validated
  8/8 on representative cases. Returns side (YES/NO) + confidence.

```bash
python newsedge.py --once          # one scan of current headlines vs markets
python newsedge.py --watch 15      # poll every 15s, log to data/alerts.log
```

Live demo output:
```
NEWS : Nvidia shares up 33% ... after Jensen Huang returns      [lat ~3m]
MKT  : Jensen Huang announced resignation or removal by Dec 2026?  (price=0.051)
==> BET NO  conf=0.60  [resign -1 [-returns]]
```
(Note the price is already 0.051 — the market had moved; a real trade needs the
"not already moved" check below. The side inference itself is correct.)

Read-only: it ALERTS, it does not trade.

## Status of the strategy build
1. **Faster sources than RSS** — *partly done* (HN/Algolia added). Next: primary
   sources for discrete events (SEC EDGAR, sports data APIs, gov pages).
2. **Direction inference** — **done** (`direction.py`, lexicon/rule based).
3. **Check the market hasn’t already moved** — **done** (`residual()`): compares
   live price to a pre-headline baseline AND the distance to the implied extreme;
   tags EARLY 🟢 / PARTIAL 🟡 / LATE 🟡 / PRICED-IN 🔴. Only EARLY is a real signal.
4. **Auto-execute** via CLOB within the window, size capped by book depth — *to do*.
5. **Backtest direction+timing** — **done** (`score_alerts.py`): reads the alert
   log, waits for markets to resolve, scores inferred side vs realized outcome and
   simulated PnL, split by residual status. Run `--watch` for days first.

### Running the validation
```bash
python newsedge.py --watch 30     # accumulate data/alerts.log (needs days)
python score_alerts.py --only-actionable --min-conf 0.6   # once markets resolve
```
Caveat: this container is ephemeral — `data/` does not survive it. For a real
multi-day dataset, run `--watch` on a persistent machine, or commit the log
periodically. Direction accuracy >50% means the signal predicts resolution;
positive ROI on EARLY alerts is the part that would actually pay.

## Why this is the most promising angle we found
Everything else died to execution cost (Polymarket taker spread) or was priced
in. Here the market structurally **lags**, and the lag is measured, not assumed.
The edge is infrastructure + speed, not a model — exactly where a focused retail
build can still compete, because the HFT firms are not in these markets.
