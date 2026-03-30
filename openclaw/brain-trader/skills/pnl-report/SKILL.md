---
name: pnl_report
description: Generate a P&L report with trade breakdown, win rate, and budget status.
---

# P&L Report

## Data Sources

1. `GET http://localhost:3000/api/v1/dashboard/metrics` — realized P&L, trade count, wins, losses, win rate, profit factor
2. `GET http://localhost:3000/api/v1/risk/state` — daily P&L, remaining budget, open exposure
3. `GET http://localhost:3000/api/v1/dashboard/trades/closed` — individual trade history
4. `GET http://localhost:3000/api/v1/dashboard/simulation` — paper simulation stats

## Report Structure

```
📊 P&L Report — [date/time]

Daily P&L:     +$X.XX / -$X.XX
Budget:        $X.XX / $10.00 remaining
Trades:        X total (W wins, L losses)
Win Rate:      XX%
Profit Factor: X.XX
Avg P&L/Trade: $X.XX

Recent Trades:
  #1  buy_up   $0.50  → WIN  +$0.40  (regime: trending_up, edge: 0.08)
  #2  buy_down $0.50  → LOSS -$0.50  (regime: volatile, edge: 0.05)
  ...
```

## Analysis

After presenting numbers:
- Is the win rate above 50%? (breakeven requires ~56% due to payout asymmetry)
- Is profit factor > 1? (above 1.5 is good)
- Are losses clustered? (could indicate wrong strategy for current conditions)
- Budget burn rate — at current rate, how many more trades before budget exhausted?
