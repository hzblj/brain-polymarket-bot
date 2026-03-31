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
6. `GET http://localhost:3000/api/v1/strategies/:id/versions` — view version config details for a strategy
7. `POST http://localhost:3000/api/v1/strategies/:id/versions` — create a new strategy version (body: `{"config": {...}}`)
8. `POST http://localhost:3000/api/v1/strategies/:id/deactivate` — disable a strategy

## Strategy Profiles

| Strategy | Best When | Worst When |
|----------|-----------|------------|
| btc-5m-momentum | Clear trends, strong directional moves | Choppy/ranging markets |
| btc-5m-mean-reversion | Overextended moves from VWAP, high mean-reversion strength | Strong sustained trends |
| btc-5m-aggressive | Fast-moving markets, high signal frequency | Low-conviction environments, choppy vol |
| btc-5m-volatility | High-vol breakout regimes, tight risk controls | Quiet/ranging markets, thin books |

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
  btc-5m-momentum:        +$3.20 (62% win rate)
  btc-5m-mean-reversion:  would have been +$1.80 (58% win rate) ← estimated
  btc-5m-aggressive:      would have been +$4.10 (68% win rate) ← estimated
  btc-5m-volatility:      would have been +$2.50 (60% win rate) ← estimated

Recommendation: Switch to btc-5m-aggressive — strong directional momentum detected in recent windows
```
