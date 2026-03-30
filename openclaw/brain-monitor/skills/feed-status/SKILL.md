---
name: feed_status
description: Check WebSocket feed connections (Binance, Coinbase, Polymarket) and data freshness.
---

# Feed Status

## Steps

1. Fetch: `GET http://localhost:3000/api/v1/dashboard/feeds`
2. Check each feed's connection status and last message time
3. Report disconnections or stale data

## Expected Feeds

| Feed | Type | Purpose |
|------|------|---------|
| binance-ws | resolver | BTC/USDT price stream |
| polymarket-ws | orderbook | UP/DOWN token order book |

## Alert Conditions

- `connected: false` → CRITICAL: feed disconnected
- `lastMessage` older than 30 seconds → WARNING: stale data
- `latencyMs` > 5000 → WARNING: high feed latency

## Output (only on problems)

```
📡 Feed Alert

❌ binance-ws DISCONNECTED
   Last message: 45s ago
   Impact: No price data → agents cannot evaluate
   Fix: Check internet, Binance status. Restart: docker compose restart price-feed

⚠️ polymarket-ws STALE
   Last message: 35s ago (threshold: 30s)
   Impact: Orderbook data may be outdated
```
