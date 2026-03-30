---
name: switch_strategy
description: Switch the active trading strategy on the Brain Polymarket Bot.
---

# Switch Strategy

Switch between available trading strategies. Always confirm with the user before switching.

## Available Strategies

1. `btc-5m-momentum` — Trend following (default)
2. `btc-5m-mean-reversion` — Contrarian / mean reversion
3. `btc-5m-basis-arb` — Cross-venue basis arbitrage
4. `btc-5m-vol-fade` — Volatility premium harvesting

## Steps

1. Fetch current strategy: `GET http://localhost:3000/api/v1/config/strategy`
2. List all strategies: `GET http://localhost:3000/api/v1/strategies`
3. Find the target strategy's ID and latest version ID
4. Switch: `POST http://localhost:3000/api/v1/config/strategy` with `{"marketConfigId": "<id>", "strategyVersionId": "<versionId>"}`
5. Verify by fetching strategy again
6. Report: old strategy → new strategy, version, key parameters

## Reset to Default

To reset: `POST http://localhost:3000/api/v1/config/strategy/reset-default`
