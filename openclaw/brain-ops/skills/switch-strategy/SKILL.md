---
name: switch_strategy
description: Switch the active trading strategy on the Brain Polymarket Bot.
---

# Switch Strategy

Switch between available trading strategies. Always confirm with the user before switching.

## Available Strategies

1. `btc-5m-momentum` — Conservative momentum following (default)
2. `btc-5m-mean-reversion` — Fades overextensions from VWAP
3. `btc-5m-aggressive` — High-frequency momentum, lower confidence threshold
4. `btc-5m-volatility` — Breakouts in high-vol regimes, tight risk

## Steps

1. Fetch current strategy: `GET http://localhost:3000/api/v1/config/strategy`
2. List all strategies: `GET http://localhost:3000/api/v1/strategies`
3. Find the target strategy's ID and latest version ID
4. Switch: `POST http://localhost:3000/api/v1/config/strategy` with `{"marketConfigId": "<id>", "strategyVersionId": "<versionId>"}`
5. Verify by fetching strategy again
6. Report: old strategy → new strategy, version, key parameters

## Inspecting and Editing Strategy Config

- View version config: `GET http://localhost:3000/api/v1/strategies/:id/versions`
- Create a new version with edited params: `POST http://localhost:3000/api/v1/strategies/:id/versions` with body `{"config": {...}}`
- Disable a strategy: `POST http://localhost:3000/api/v1/strategies/:id/deactivate`

## Reset to Default

To reset: `POST http://localhost:3000/api/v1/config/strategy/reset-default`
