---
name: system_status
description: Get a comprehensive status overview of the entire Brain Polymarket Bot system.
---

# System Status

Fetch and present a complete system status overview.

## Data Sources

Fetch all in parallel:
1. `GET http://localhost:3000/api/v1/dashboard/state` — mode, strategy, kill switch
2. `GET http://localhost:3000/api/v1/dashboard/health` — service health (14 services)
3. `GET http://localhost:3000/api/v1/dashboard/metrics` — P&L, trades, win rate
4. `GET http://localhost:3000/api/v1/risk/state` — budget, remaining, P&L
5. `GET http://localhost:3000/api/v1/dashboard/pipeline` — latest pipeline decisions
6. `GET http://localhost:3000/api/v1/dashboard/snapshot` — market prices, spread, depth

## Output Format

```
🧠 Brain Polymarket Bot — Status

Mode:      paper | Strategy: btc-5m-momentum v1
Kill:      OFF   | Trading: enabled
Budget:    $8.50 / $10.00 remaining

📊 Today
P&L: +$1.20 | Trades: 5 (3W 2L) | Win: 60% | PF: 1.8

📈 Market
BTC: $67,500 | Spread: 120bps | Depth: 0.72 | Momentum: 0.65

🔄 Pipeline
Regime: trending_up (0.78) → Edge: up 0.08 (0.65) → Supervisor: buy_up $0.50 (0.72) → Risk: passed → Execution: filled

🏥 Services: 14/14 healthy
```

If any service is unhealthy, list it explicitly.
