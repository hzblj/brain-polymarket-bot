---
name: optimizer_control
description: Enable, disable, or check status of the automatic strategy optimizer.
---

# Optimizer Control

## Check Status

```
GET http://localhost:3000/api/v1/optimizer/status
```

Returns:
- `enabled`: boolean — is auto-optimization running?
- `isRunning`: boolean — is a report being generated right now?
- `lastRunAt`: ISO timestamp of last run
- `intervalMs`: how often it runs (default: 86400000 = 24h)

## Enable

```
POST http://localhost:3000/api/v1/optimizer/enable
```

Starts automatic periodic report generation.

## Disable

```
POST http://localhost:3000/api/v1/optimizer/disable
```

Stops automatic optimization. Manual reports via `generate-report` still work.

## Safety

- Enabling optimizer = periodic LLM calls = costs tokens
- Default interval: once per day (24h)
- `AUTO_APPLY_ENABLED=false` by default — suggestions are NOT auto-applied
- Always review suggestions before implementing via brain-ops agent
