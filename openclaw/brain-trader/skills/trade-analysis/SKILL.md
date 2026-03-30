---
name: trade_analysis
description: Deep analysis of recent trades — why they won or lost, agent accuracy, signal quality.
---

# Trade Analysis

## Data Sources

1. `GET http://localhost:3000/api/v1/agent/traces?limit=20` — recent agent decisions with full reasoning
2. `GET http://localhost:3000/api/v1/dashboard/trades/closed` — trade outcomes
3. `GET http://localhost:3000/api/v1/analyzer/analyses?limit=10` — post-trade analyzer results
4. `GET http://localhost:3000/api/v1/dashboard/pipeline` — current pipeline state

## Analysis Framework

For each recent trade:
1. **Regime accuracy** — Was the regime classification correct in hindsight?
2. **Edge quality** — Did the estimated edge materialize? Was direction correct?
3. **Supervisor decision** — Was the confidence justified by the outcome?
4. **Risk check** — Did risk appropriately gate or pass the trade?

## Patterns to Detect

- **False edges**: High-confidence edges that consistently lose → agent overconfident
- **Missed opportunities**: Holds during periods of strong realized edge → agent too conservative
- **Regime mismatch**: Trades in wrong regime (e.g., momentum trades during mean-reversion periods)
- **Time-of-day effects**: Better performance at certain hours?
- **Spread vs edge**: Are we trading when spread eats the edge?

## Output

Present findings as actionable insights:
- "Edge agent is 70% accurate on direction but overestimates magnitude by 2x"
- "3 of last 5 losses were in volatile regime — consider disabling trading in volatile"
- "Best performance window: 30-60s before close"
