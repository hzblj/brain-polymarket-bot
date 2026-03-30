---
name: kill_switch
description: Emergency kill switch — halt or resume all trading immediately.
---

# Kill Switch

Activate or deactivate the emergency kill switch.

## Activate (STOP all trading)

```
POST http://localhost:3000/api/v1/risk/kill-switch/on
```

This immediately blocks ALL trade approvals. No trades will execute until deactivated.

## Deactivate (RESUME trading)

```
POST http://localhost:3000/api/v1/risk/kill-switch/off
```

## Toggle Execution Mode

To switch between paper/live/disabled:
```
POST http://localhost:3000/api/v1/config
{"trading": {"mode": "paper"}}
```

Valid modes: `disabled`, `paper`, `live`

## Steps

1. Fetch current state: `GET http://localhost:3000/api/v1/risk/state`
2. Report current: kill switch on/off, trading enabled/disabled, mode
3. Execute the requested action
4. Verify new state
5. Confirm to user

## Safety

- Activating kill switch: do it immediately, no confirmation needed
- Deactivating kill switch: confirm with user first
- Switching to `live` mode: ALWAYS confirm, warn about real funds
