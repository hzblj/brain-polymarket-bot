---
name: whale_scan
description: Scan for large BTC transactions and exchange flow patterns.
---

# Whale Scan

## Data Sources

1. `GET http://localhost:3000/api/v1/whales/current` — current whale features
2. `GET http://localhost:3000/api/v1/whales/transactions?limit=20` — recent large transactions
3. `GET http://localhost:3000/api/v1/whales/history?limit=30` — historical whale activity

## Key Metrics

| Metric | What It Means |
|--------|---------------|
| `largeTransactionCount` | Number of >10 BTC transactions |
| `netExchangeFlowBtc` | Positive = inflow (bearish), negative = outflow (bullish) |
| `exchangeFlowPressure` | -1 (strong outflow/bullish) to +1 (strong inflow/bearish) |
| `whaleVolumeBtc` | Total whale BTC volume |
| `abnormalActivityScore` | 0 (normal) to 1 (highly unusual) |

## Transaction Detail

Each transaction includes:
- `amountBtc` / `amountUsd`
- `direction`: inbound/outbound
- `isExchangeInflow` / `isExchangeOutflow`
- `fromAddress` / `toAddress`

## Alert Thresholds

- `abnormalActivityScore` > 0.7 → ALERT: unusual whale activity
- `|netExchangeFlowBtc|` > 50 BTC in 5 minutes → significant flow
- Single transaction > 100 BTC → whale alert

## Report Format

```
🐋 Whale Activity

Flow: -45.2 BTC net OUTFLOW (bullish signal)
Pressure: -0.62 (moderate bullish)
Transactions: 7 large (>10 BTC)
Abnormal Score: 0.35 (normal range)

Notable:
  • 82 BTC outflow from Binance → cold wallet (12:34 UTC)
  • 34 BTC inflow to Coinbase (12:37 UTC)

Bias: Mildly bullish — net outflow suggests accumulation
```

Only report when there's meaningful activity (abnormalActivityScore > 0.3 or |netExchangeFlowBtc| > 20).
