---
name: strategy_review
description: Compare strategy performance and recommend which strategy to use based on current market conditions.
---

# Strategy Review

## Data Sources

1. `GET http://localhost:3000/api/v1/strategies` — all available strategies
2. `GET http://localhost:3000/api/v1/config/strategy` — currently active strategy
3. `GET http://localhost:3000/api/v1/optimizer/reports?limit=5` — strategy optimizer reports
4. `GET http://localhost:3000/api/v1/dashboard/snapshot` — current market conditions
5. `GET http://localhost:3000/api/v1/agent/traces?limit=30` — recent agent decisions

## Strategy Profiles

| Strategy | Best When | Worst When |
|----------|-----------|------------|
| momentum | Clear trends, strong directional moves | Choppy/ranging markets |
| mean-reversion | Overextended moves, high mean-reversion strength | Strong sustained trends |
| basis-arb | Exchange leads Polymarket, wide basis | Tight basis, noisy exchange prices |
| vol-fade | High implied vol, low realized vol | Vol crisis, thin books |

## Analysis

1. Assess current market regime from recent traces
2. Check which strategy would have performed best on recent windows
3. Compare active strategy's recent performance vs alternatives
4. Factor in optimizer suggestions if available

## Recommendation Format

```
📋 Strategy Review

Current: btc-5m-momentum v1
Market Regime: trending_up (last 10 windows: 7 trending, 2 mean-reverting, 1 quiet)

Performance (last 50 trades):
  Momentum:       +$3.20 (62% win rate)
  Mean Reversion: would have been +$1.80 (58% win rate) ← estimated
  Basis Arb:      would have been +$4.10 (68% win rate) ← estimated

Recommendation: Switch to basis-arb — wide basis detected in recent windows
```
