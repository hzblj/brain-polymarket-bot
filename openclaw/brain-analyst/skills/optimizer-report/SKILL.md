---
name: optimizer_report
description: Generate or fetch strategy optimization reports — performance by regime, hour, agent accuracy, parameter suggestions.
---

# Strategy Optimizer Report

## Fetch Existing Reports

```
GET http://localhost:3000/api/v1/optimizer/reports?limit=5
```

Each report contains:
- `performanceByRegime`: P&L and win rate per regime type
- `performanceByHour`: P&L per hour of day
- `agentAccuracy`: edge prediction, confidence calibration, regime accuracy
- `riskMetrics`: rejection rate, top rejection reasons
- `patterns`: detected behavioral patterns
- `suggestions`: concrete parameter changes with confidence and priority
- `executiveSummary`: one-paragraph overview

## Generate New Report

```
POST http://localhost:3000/api/v1/optimizer/generate-report
{"periodDays": 7}
```

Warning: This triggers LLM analysis — costs tokens. Ask before generating.

## Report Format

```
📋 Optimization Report — [period]

Executive Summary:
[1-2 sentences on overall performance and key finding]

Performance by Regime:
  trending_up:     12 trades, +$2.40, 67% win
  trending_down:    8 trades, -$0.80, 38% win ← WEAK
  mean_reverting:   5 trades, +$1.60, 80% win ← STRONG
  volatile:         3 trades, -$1.50, 0% win ← AVOID
  quiet:            0 trades

Agent Accuracy:
  Edge prediction:  68% correct
  Confidence cal:   0.72 (1.0 = perfect)
  Regime accuracy:  74%

Top Suggestions:
  1. [HIGH] Disable trading in volatile regime — 0% win rate, -$1.50
  2. [MED] Increase mean-reversion allocation — 80% win rate
  3. [LOW] Adjust entry window from 90s→75s — marginal timing improvement
```
