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

## The monitor (newsedge.py)

Watches fast free RSS feeds (BBC world/biz/politics, CoinDesk), indexes active
non-sports Polymarket markets by proper-noun entity, and alerts when a fresh
headline matches a market — with the current price and the headline’s age.

```bash
python newsedge.py --once          # one scan of current headlines vs markets
python newsedge.py --watch 15      # poll every 15s, log alerts to data/alerts.log
```

Live demo caught, at ~3 min latency: *“Nvidia shares up 33% after Jensen Huang
returns”* → market *“Jensen Huang announced resignation or removal by Dec 2026?”*
Matching requires a shared multi-word proper noun (or two proper nouns), so loose
keyword overlap (“ai”, “french”) no longer fires.

Read-only: it ALERTS, it does not trade.

## To turn this into a strategy (eyes open)
1. **Faster sources than RSS.** RSS already costs you minutes. For discrete
   events, poll the primary source (gov/court/company IR page, sports data API)
   or a social firehose. This is the real engineering edge.
2. **Direction inference.** The headline must map to YES/NO. Needs an NLP/LLM
   step per (headline, market question).
3. **Check the market hasn’t already moved** before acting (compare current price
   to its pre-news level) — only trade the un-repriced residual.
4. **Auto-execute** via the CLOB API within the window, with size limited by
   book depth.
5. Backtest direction+timing on logged alerts before risking money.

## Why this is the most promising angle we found
Everything else died to execution cost (Polymarket taker spread) or was priced
in. Here the market structurally **lags**, and the lag is measured, not assumed.
The edge is infrastructure + speed, not a model — exactly where a focused retail
build can still compete, because the HFT firms are not in these markets.
