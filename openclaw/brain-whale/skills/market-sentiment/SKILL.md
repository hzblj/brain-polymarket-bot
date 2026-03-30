---
name: market_sentiment
description: Synthesize whale activity + derivatives data into a unified market sentiment signal.
---

# Market Sentiment

Combines on-chain whale data with derivatives market signals for a composite view.

## Data Sources (fetch all in parallel)

1. `GET http://localhost:3000/api/v1/whales/current` — whale features
2. `GET http://localhost:3000/api/v1/derivatives/current` — derivatives features
3. `GET http://localhost:3000/api/v1/dashboard/snapshot` — current market prices
4. `GET http://localhost:3000/api/v1/dashboard/pipeline` — latest agent decision

## Sentiment Framework

Score each dimension -1 (bearish) to +1 (bullish):

| Dimension | Source | Weight |
|-----------|--------|--------|
| Exchange flow | `exchangeFlowPressure` (inverted: outflow=bullish) | 25% |
| Funding pressure | `fundingPressure` (inverted: high funding=bearish) | 25% |
| Liquidation bias | `liquidationImbalance` (inverted: long liqs=bearish) | 20% |
| OI trend | `oiTrend` × price direction | 15% |
| Whale abnormality | `abnormalActivityScore` × flow direction | 15% |

Composite = weighted average → -1 (strong bearish) to +1 (strong bullish)

## Report Format

```
🧭 Market Sentiment — Composite

Score: +0.34 (MILDLY BULLISH)

Breakdown:
  Exchange Flow:    +0.62 (net outflow — accumulation)
  Funding:          -0.15 (slightly crowded long)
  Liquidations:     +0.20 (shorts getting squeezed)
  OI Trend:         +0.45 (rising OI + rising price)
  Whale Activity:   +0.10 (normal activity, slight outflow)

Current Strategy: btc-5m-momentum
Pipeline: regime=trending_up, edge=up 0.06
Alignment: ✅ Sentiment CONFIRMS current agent bias

Recommendation: Current strategy aligned with sentiment. No action needed.
```

When sentiment CONTRADICTS agent decisions:
```
⚠️ Sentiment DIVERGES from agent
Sentiment: -0.45 (bearish) but agent says: buy_up
Consider: monitoring closely, reducing position size, or switching to vol-fade
```
