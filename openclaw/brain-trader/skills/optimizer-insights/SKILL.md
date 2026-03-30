---
name: optimizer_insights
description: Pull latest strategy optimizer insights and translate them into concrete parameter changes.
---

# Optimizer Insights

Bridge between brain-analyst's reports and brain-ops's config changes.

## Steps

1. Fetch latest report: `GET http://localhost:3000/api/v1/optimizer/reports?limit=1`
2. Extract `suggestions` array — each has:
   - `category`: what area (risk, timing, strategy, agent)
   - `suggestion`: what to change
   - `rationale`: why
   - `confidence`: 0-1 how confident
   - `priority`: high/medium/low
   - `autoApplicable`: could it be applied automatically?
3. Translate into actionable commands for the user

## Output Format

```
💡 Optimizer Insights (from latest report)

HIGH PRIORITY:
  1. Disable volatile regime trading
     → Update supervisor prompt to always HOLD in volatile
     Confidence: 0.85 | Based on: 0% win rate in volatile (8 trades)

  2. Reduce max spread for momentum strategy: 250→180 bps
     → POST /api/v1/risk/config {"maxSpreadBps": 180}
     Confidence: 0.72 | Based on: trades with >180bps spread lose 67%

MEDIUM PRIORITY:
  3. Extend entry window start from 90s to 120s
     → Requires strategy version update
     Confidence: 0.61 | Based on: earlier entries perform 12% better

Want me to ask brain-ops to apply any of these?
```
