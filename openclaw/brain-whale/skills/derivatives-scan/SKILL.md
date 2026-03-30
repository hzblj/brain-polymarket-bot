---
name: derivatives_scan
description: Scan derivatives market — funding rates, open interest, liquidations.
---

# Derivatives Scan

## Data Sources

1. `GET http://localhost:3000/api/v1/derivatives/current` — current derivatives features
2. `GET http://localhost:3000/api/v1/derivatives/liquidations?limit=30` — recent liquidations
3. `GET http://localhost:3000/api/v1/derivatives/history?limit=30` — historical features

## Key Metrics

| Metric | Range | Interpretation |
|--------|-------|----------------|
| `fundingRate` | typically -0.01% to +0.03% | Positive = longs pay, negative = shorts pay |
| `fundingRateAnnualized` | % | Annual equivalent |
| `fundingPressure` | -1 to +1 | Normalized funding signal |
| `openInterestUsd` | $ | Total futures OI |
| `openInterestChangePct` | % | OI change rate |
| `oiTrend` | -1 to +1 | Direction of OI change |
| `longLiquidationUsd` | $ | Longs getting liquidated |
| `shortLiquidationUsd` | $ | Shorts getting liquidated |
| `liquidationImbalance` | -1 to +1 | Positive = more longs liquidated |
| `liquidationIntensity` | 0 to 1 | How intense liquidations are |
| `derivativesSentiment` | -1 to +1 | Composite sentiment |

## Liquidation Detail

Each liquidation:
- `symbol`, `side` (LONG/SHORT), `price`, `quantity`, `quantityUsd`, `eventTime`

## Signal Interpretation

| Condition | Signal |
|-----------|--------|
| Funding > +0.02% + rising OI | Crowded long — risk of long squeeze down |
| Funding < -0.01% + rising OI | Crowded short — risk of short squeeze up |
| Mass long liquidations | Cascade selling — bearish momentum |
| Mass short liquidations | Short squeeze — bullish momentum |
| OI dropping + price flat | Positions closing — volatility decreasing |
| OI rising + price rising | Trend confirmation — bullish |

## Report Format

```
📊 Derivatives Snapshot

Funding: +0.012% (annualized: +13.1%) — moderately crowded long
OI: $28.4B (+2.1% last hour) — rising
Sentiment: -0.23 (mildly bearish)

Liquidations (last 30):
  Longs: $2.4M | Shorts: $0.8M
  Imbalance: +0.50 (longs getting hit)
  Intensity: 0.42 (moderate)

Signal: Bearish pressure — crowded longs + long liquidations
Impact on 5m binary: slight DOWN bias
```
