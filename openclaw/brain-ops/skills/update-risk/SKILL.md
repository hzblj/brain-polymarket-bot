---
name: update_risk
description: Update risk configuration — trade size, daily budget, spread limits, depth, trades per window.
---

# Update Risk Config

Modify risk parameters on the Brain Polymarket Bot.

## Current Defaults

- `maxSizeUsd`: $0.50 (max per trade)
- `dailyLossLimitUsd`: $10.00 (daily budget — stops when net losses hit this)
- `maxSpreadBps`: 300 (max spread in basis points)
- `minDepthScore`: 0.1 (min orderbook depth)
- `maxTradesPerWindow`: 1 (trades per 5-min window)

## Steps

1. Fetch current state: `GET http://localhost:3000/api/v1/risk/state`
2. Show current values and remaining budget to user
3. Ask what to change (or parse from user request)
4. Update: `POST http://localhost:3000/api/v1/risk/config` with changed fields only, e.g.:
   ```json
   {"maxSizeUsd": 1.0, "dailyLossLimitUsd": 20}
   ```
5. Verify by fetching state again
6. Report: what changed, old → new values

## Safety Rules

- Never set `dailyLossLimitUsd` above $50 without explicit confirmation
- Never set `maxSizeUsd` above $5 without explicit confirmation
- Warn if `maxSizeUsd` > `dailyLossLimitUsd / 5`
