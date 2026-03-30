---
name: replay_run
description: Run a historical replay to test strategies against past market data with real agent evaluation.
---

# Replay Run

Run agent decisions on historical market data to evaluate strategy performance.

## Steps

1. Ask user for time range (or default to last 1 hour)
2. Start replay: `POST http://localhost:3000/api/v1/replay/run`
   ```json
   {
     "fromTime": 1700000000000,
     "toTime": 1700003600000,
     "reEvaluateAgents": true
   }
   ```
3. Wait for completion (replay processes each 5-min window sequentially)
4. Fetch result: `GET http://localhost:3000/api/v1/replay/<replayId>`
5. Present results

## Parameters

- `reEvaluateAgents: true` — Calls the real agent-gateway to re-evaluate each window (uses LLM tokens!)
- `reEvaluateAgents: false` — Only replays original decisions, no new LLM calls (free, fast)

## Output

```
🔄 Replay Results — [fromTime] to [toTime]

Windows: X | Trades: Y | Holds: Z
P&L: $X.XX | Win Rate: XX%

Decisions Changed: X/Y (vs original)
  Window 1: hold → buy_up (would have won +$0.40)
  Window 5: buy_down → hold (avoided loss of -$0.50)
```

## Cost Warning

With `reEvaluateAgents: true`, each window makes 3 LLM calls (regime + edge + supervisor). A 1-hour replay = ~12 windows = ~36 LLM calls. Warn user about cost before running.

## Replay Summary

For aggregate stats: `GET http://localhost:3000/api/v1/replay/summary`
