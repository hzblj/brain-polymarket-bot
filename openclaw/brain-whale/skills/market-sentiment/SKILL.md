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
5. `GET http://localhost:3000/api/v1/whales/blockchain` — blockchain mempool, fee tiers, exchange flows, and trend deltas

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

### Blockchain On-Chain Confirmation (from `/api/v1/whales/blockchain`)

Use blockchain data as a confirming layer on top of the composite score — it does not carry its own weight but can strengthen or temper the signal:

- **Fee trend** (`trend.feeChange`): a sharp fee spike alongside bearish whale/derivatives signals confirms urgency (panic selling); stable or falling fees during bullish signals confirm calm accumulation.
- **Mempool activity** (`trend.txCountChange`, `mempool.vsize`): surging unconfirmed tx volume corroborates elevated on-chain pressure; low mempool congestion confirms a quiet, range-bound environment.
- **Exchange flows** (`notableTransactions.exchangeInflows`, `notableTransactions.exchangeOutflows`): cross-validate against `exchangeFlowPressure` from the whale tracker — agreement raises confidence; divergence warrants caution.

Note any on-chain confirmation or divergence in the report narrative.

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
