# gridlab — grid / "pendulum" backtester on real crypto

Tests the strategy a trader described: quote levels around a center, buy when
price crosses one DOWN, sell one level UP, harvesting each oscillation; optional
DCA (unbounded averaging-down). Data: Kraken OHLC (free, keyless), plus a cached
2022 Coinbase bear-market slice for tail testing.

The point is to measure what pretty grid backtests hide: **max drawdown and
ruin in trends**, and whether profit survives **fees**.

```bash
python gridbot.py --interval 1440 --spacing 0.01 --levels 10 --size 200 --dca --fee 0.0002
python gridbot.py --pair BEAR2022 --interval 1440 --spacing 0.01 --levels 10 --size 1500 --dca
```

## Findings (BTC, $10k capital)

| scenario | config | return | max DD | note |
|---|---|---:|---:|---|
| 2024–26 (choppy), maker fee | 1% / 10 lv / $200 DCA | **+6.3%** | 10% | buy&hold −35% |
| 2024–26, taker fee 0.1% | same | +3.5% | 10% | survives taker too |
| 2022 bear −65%, conservative | 1% / 10 lv / $200 DCA | −9.8% | 16% | bag held, no ruin |
| 2022 bear, wider grid | 3% / 12 lv / $200 DCA | −0.5% | 5% | chop harvested the fall |
| 2022 bear, **oversized** | 1% / 10 lv / **$900** DCA | −44% | 66% | over-leveraged |
| 2022 bear, **oversized** | 1% / 10 lv / **$1500** DCA | **−79%** | **101%** | **ACCOUNT RUINED** |

## What this means

- The grid **genuinely harvests range/chop volatility** and, unlike every
  Polymarket idea we tested, it is a **maker** strategy (limit orders), so it
  survives fees instead of dying to the spread. On real 2024–26 BTC it made
  **+6.3% net of maker fees** while buy&hold lost 35%, drawdown under 10%.
- It is **short volatility / short the tail**: it loses in sustained trends. With
  **conservative sizing** that loss is small and bounded — it lost only ~7–10%
  through the 2022 −65% bear while still beating buy&hold.
- **Ruin is a sizing/leverage failure, not a flaw in the idea.** Oversize the DCA
  (inventory ≫ capital) and a trend liquidates you (−79%, wiped). The "beautiful
  curve until it dies" is someone running it over-leveraged.

## The safe-sizing rule

Let `max_inventory = size × (grid depth you will ever fill)`. Keep
`max_inventory ≤ capital` (i.e. **no leverage**), so that if price trends all the
way to the grid floor you simply hold the bag — underwater but never liquidated.
Cap the grid depth; never let DCA add unbounded on borrowed money. Edge is
modest (a few % per year of harvested volatility) and is **payment for bearing
trend risk** — real, costed, survivable, not free money.

## Caveats still open
- Fills assume a limit order executes when price touches the level (fair on
  liquid BTC; worse on alts).
- No perp funding modelled — run it **spot** to avoid funding and liquidation.
- Daily/hourly candles undercount intra-candle path; minute data would refine
  fill counts (and fees).
