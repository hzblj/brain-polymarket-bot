---
name: budget_check
description: Check remaining daily trading budget and alert on low/exhausted budget or kill switch.
---

# Budget Check

## Steps

1. Fetch: `GET http://localhost:3000/api/v1/risk/state`
2. Extract: `remainingDailyBudgetUsd`, `killSwitchActive`, `tradingEnabled`, `state.dailyPnlUsd`
3. Evaluate against thresholds
4. **Only alert if there's a problem**

## Thresholds

| Condition | Level | Alert |
|-----------|-------|-------|
| `remainingDailyBudgetUsd` <= 0 | CRITICAL | Budget exhausted, trading stopped |
| `remainingDailyBudgetUsd` < $2 | WARNING | Budget low |
| `remainingDailyBudgetUsd` < $5 | INFO | Budget getting low (only in reports) |
| `killSwitchActive` = true | CRITICAL | Emergency stop active |
| `tradingEnabled` = false | WARNING | Trading manually disabled |

## Alert Format

```
🛑 BUDGET EXHAUSTED
Daily P&L: -$10.00 | Remaining: $0.00 / $10.00
Trading has automatically stopped for today.
Budget resets at midnight UTC.
```

or

```
⚠️ Budget Low: $1.80 / $10.00 remaining
Daily P&L: -$8.20 | Trades today: 16
At current loss rate, ~3 more trades before budget exhausted.
```

or

```
🚨 KILL SWITCH ACTIVE
All trading halted by emergency kill switch.
To resume: openclaw run "deactivate the kill switch"
```
