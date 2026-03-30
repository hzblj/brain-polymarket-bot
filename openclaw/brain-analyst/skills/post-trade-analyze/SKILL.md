---
name: post_trade_analyze
description: Analyze recent trades — edge accuracy, confidence calibration, signal quality, and improvement suggestions.
---

# Post-Trade Analysis

## Data Sources

1. `GET http://localhost:3000/api/v1/analyzer/analyses?limit=20` — recent LLM trade analyses
2. `GET http://localhost:3000/api/v1/analyzer/analyses?verdict=bad_trade&limit=10` — bad trades specifically
3. `GET http://localhost:3000/api/v1/dashboard/trades/closed` — trade outcomes for context

## Trigger New Analysis

To analyze a specific trade:
```
POST http://localhost:3000/api/v1/analyzer/analyze
{"orderId": "<order-id>"}
```

To analyze all trades in a window:
```
POST http://localhost:3000/api/v1/analyzer/analyze-window
{"windowId": "<window-id>"}
```

## Analysis Fields per Trade

| Field | Meaning |
|-------|---------|
| `verdict` | good_trade, bad_trade, unlucky, lucky |
| `edgeAccurate` | Was edge direction prediction correct? |
| `confidenceCalibration` | over_confident, under_confident, well_calibrated |
| `misleadingSignals` | Which signals led the agent astray |
| `correctSignals` | Which signals were accurate |
| `improvementSuggestions` | Specific parameter/prompt changes |
| `llmReasoning` | Full LLM reasoning chain |

## Report Format

```
🔬 Post-Trade Analysis — Last 20 trades

Edge Accuracy: 14/20 (70%) correct direction
Confidence Calibration:
  High (>0.7): 8 trades, 6 wins (75%) ← well calibrated
  Medium (0.5-0.7): 10 trades, 5 wins (50%) ← overconfident
  Low (<0.5): 2 trades, 1 win (50%)

Misleading Signals (top 3):
  1. bookPressure — led to 4 wrong calls
  2. basisSignal — unreliable in volatile regime
  3. momentum — lagging in mean-reversion setups

Suggestions:
  • Reduce edge weight on bookPressure in volatile regime
  • Increase minConfidence to 0.75 for momentum strategy
  • Basis arb: only trade when |basisBps| > 40 (currently 30)
```
