---
name: analytics_health
description: Check health of analytical services — post-trade analyzer, strategy optimizer, whale tracker, derivatives feed.
---

# Analytics Service Health

## Steps

1. Fetch all in parallel:
   - `GET http://localhost:3000/api/v1/whales/health`
   - `GET http://localhost:3000/api/v1/derivatives/health`
   - `GET http://localhost:3000/api/v1/whales/status`
   - `GET http://localhost:3000/api/v1/derivatives/status`
   - `GET http://localhost:3000/api/v1/optimizer/status`
   - `GET http://localhost:3000/api/v1/analyzer/analyses?limit=1` (check if analyzer responds)

2. Evaluate:
   - Is whale tracker connected to mempool.space? Check `wsConnected`
   - Is derivatives feed connected to Binance futures? Check `wsConnected`
   - Is optimizer enabled? Is it running? When was last run?
   - Is analyzer responsive?

## Alert on

- WebSocket disconnection on whale-tracker or derivatives-feed
- Optimizer hasn't run in >48h (if enabled)
- Analyzer returning errors
- Any service returning non-200

## Output (only on problems)

```
🔬 Analytics Health Alert

❌ whale-tracker: mempool.space WebSocket DISCONNECTED
   Last connected: 15m ago
   Impact: No whale flow data for trading features
   Fix: docker compose restart whale-tracker

⚠️ strategy-optimizer: last run 52h ago (threshold: 48h)
   Status: enabled but stale
   Fix: POST /api/v1/optimizer/generate-report to force run

✅ derivatives-feed: healthy
✅ post-trade-analyzer: healthy
```
