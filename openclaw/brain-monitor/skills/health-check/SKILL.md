---
name: health_check
description: Check health of all 14 Brain Polymarket Bot services and report problems.
---

# Health Check

## Steps

1. Fetch: `GET http://localhost:3000/api/v1/dashboard/health`
2. For each service, evaluate status and latency
3. **Only report problems.** If all healthy, return empty/nothing.

## Thresholds

| Status | Meaning | Action |
|--------|---------|--------|
| `healthy` + latency <500ms | Normal | Silent |
| `healthy` + latency >2000ms | Slow | Warning |
| `degraded` | Responding but errors | Warning |
| `unhealthy` | Not responding | CRITICAL |

## Expected Services (14)

market-discovery, price-feed, orderbook, feature-engine, risk, execution, config, agent-gateway, replay, whale-tracker, post-trade-analyzer, strategy-optimizer, derivatives-feed, dashboard

## Alert Format

```
🚨 Service Alert

CRITICAL:
  ❌ orderbook — unhealthy (unreachable)
     Fix: docker compose restart orderbook

WARNING:
  ⚠️ agent-gateway — 3200ms latency (normal: <500ms)
     May indicate: LLM provider throttling

All other services: healthy ✅
```

## Remediation Suggestions

- Service unreachable → `docker compose restart <service>`
- High latency on agent-gateway → Check LLM provider status, API key quota
- Multiple services down → `docker compose down && docker compose up -d`
- WebSocket services (price-feed, orderbook) → Check internet, exchange status
