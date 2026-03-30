#!/usr/bin/env bash
set -euo pipefail

# ─── OpenClaw Setup for Brain Polymarket Bot ─────────────────────────────────
# Run this after `openclaw onboard` to set up all cron jobs and automations.
# Usage: bash scripts/openclaw-setup.sh

echo "🧠 Setting up OpenClaw for Brain Polymarket Bot..."

API_GATEWAY="http://localhost:3000"

# ─── 1. Health Check — every 2 minutes ──────────────────────────────────────
# Pings all 14 services and alerts if any are unhealthy.

openclaw cron add \
  --name "brain-health-check" \
  --cron "*/2 * * * *" \
  --session isolated \
  --agent brain-monitor \
  --message "Run a health check on the Brain Polymarket Bot.

Fetch ${API_GATEWAY}/api/v1/dashboard/health and analyze the response.

For each service, check:
- status: 'healthy', 'degraded', or 'unhealthy'
- latencyMs: flag anything over 2000ms

Services to check: market-discovery, price-feed, orderbook, feature-engine, risk, execution, config, agent-gateway, replay.

ONLY report if there's a problem. If all services are healthy, respond with nothing.
If any service is unhealthy or degraded, report which ones and their latency." \
  --model "openai/gpt-4o-mini" \
  --announce \
  --enabled

echo "  ✅ Health check cron (every 2 min)"

# ─── 2. P&L Report — every 30 minutes ──────────────────────────────────────
# Tracks daily P&L, win rate, remaining budget.

openclaw cron add \
  --name "brain-pnl-report" \
  --cron "*/30 * * * *" \
  --session "session:brain-pnl" \
  --agent brain-trader \
  --message "Check the Brain Polymarket Bot trading performance.

Fetch these endpoints and summarize:

1. ${API_GATEWAY}/api/v1/risk/state — get dailyPnlUsd, remainingDailyBudgetUsd, tradesInWindow, killSwitch status
2. ${API_GATEWAY}/api/v1/dashboard/metrics — get realizedPnl, tradeCount, winCount, lossCount, winRate, profitFactor

Report a concise summary:
- Daily P&L: \$X.XX
- Remaining budget: \$X.XX / \$10.00
- Trades: X (W wins, L losses) — XX% win rate
- Profit factor: X.XX
- Kill switch: on/off

If daily budget is below \$2, warn me. If kill switch is on, alert immediately." \
  --model "openai/gpt-4o-mini" \
  --announce \
  --enabled

echo "  ✅ P&L report cron (every 30 min)"

# ─── 3. Strategy Monitor — every 15 minutes ────────────────────────────────
# Checks which strategy is active and recent agent decisions.

openclaw cron add \
  --name "brain-strategy-monitor" \
  --cron "*/15 * * * *" \
  --session "session:brain-strategy" \
  --agent brain-trader \
  --message "Check the active strategy and recent agent decisions.

Fetch:
1. ${API_GATEWAY}/api/v1/config/strategy — active strategy key, version
2. ${API_GATEWAY}/api/v1/dashboard/pipeline — latest pipeline state (regime, edge, supervisor, risk, execution)
3. ${API_GATEWAY}/api/v1/agent/traces?limit=5 — recent agent traces

Summarize:
- Active strategy and version
- Latest pipeline state: what did each agent decide?
- Any interesting patterns in recent traces (all holds? repeated regime?)

ONLY report if there's something notable. If everything is routine holds with no trades, say nothing." \
  --model "openai/gpt-4o-mini" \
  --announce \
  --enabled

echo "  ✅ Strategy monitor cron (every 15 min)"

# ─── 4. Morning Brief — daily at 8:00 AM ───────────────────────────────────
# Comprehensive daily summary of yesterday's performance.

openclaw cron add \
  --name "brain-morning-brief" \
  --cron "0 8 * * *" \
  --tz "Europe/Prague" \
  --session isolated \
  --agent brain-trader \
  --message "Generate a morning brief for the Brain Polymarket Bot.

Fetch:
1. ${API_GATEWAY}/api/v1/dashboard/metrics — yesterday's performance
2. ${API_GATEWAY}/api/v1/risk/state — current risk state and budget
3. ${API_GATEWAY}/api/v1/config/strategy — active strategy
4. ${API_GATEWAY}/api/v1/dashboard/health — service health
5. ${API_GATEWAY}/api/v1/dashboard/simulation — simulation summary

Create a brief report:
📊 **Daily Brief — Brain Polymarket Bot**
- Yesterday's P&L and trade count
- Win rate and profit factor
- Current budget remaining
- Active strategy
- Service health status
- Any anomalies or suggestions

Keep it concise — max 10 lines." \
  --model "openai/gpt-4o" \
  --thinking "low" \
  --announce \
  --enabled

echo "  ✅ Morning brief cron (daily 8:00 CET)"

# ─── 5. Budget Alert — every 5 minutes ─────────────────────────────────────
# Alerts when daily budget is critically low or exhausted.

openclaw cron add \
  --name "brain-budget-alert" \
  --cron "*/5 * * * *" \
  --session isolated \
  --agent brain-monitor \
  --message "Check if the trading budget is critically low.

Fetch ${API_GATEWAY}/api/v1/risk/state and check:
- remainingDailyBudgetUsd
- killSwitchActive
- tradingEnabled

Rules:
- If remainingDailyBudgetUsd <= 0: ALERT '🛑 Daily budget exhausted! Trading stopped.'
- If remainingDailyBudgetUsd < 2 and > 0: WARN '⚠️ Budget low: \$X.XX remaining'
- If killSwitchActive is true: ALERT '🚨 Kill switch is ON!'
- If tradingEnabled is false: WARN '⏸️ Trading is disabled'
- Otherwise: say nothing (no alert needed)" \
  --model "openai/gpt-4o-mini" \
  --announce \
  --enabled

echo "  ✅ Budget alert cron (every 5 min)"

# ─── 6. Service Restart Detector — every 10 minutes ────────────────────────
# Detects if services restarted unexpectedly.

openclaw cron add \
  --name "brain-restart-detector" \
  --cron "*/10 * * * *" \
  --session "session:brain-restarts" \
  --agent brain-monitor \
  --message "Check for service restarts or connectivity issues.

Fetch ${API_GATEWAY}/api/v1/dashboard/health and compare with previous check.

If any service went from healthy to unhealthy, or latency increased by >3x from last check, report it. Remember the state for next comparison.

If everything is stable, say nothing." \
  --model "openai/gpt-4o-mini" \
  --announce \
  --enabled

echo "  ✅ Restart detector cron (every 10 min)"

# ─── 7. Weekly Strategy Review — Sundays at 10:00 AM ───────────────────────
# Deep analysis of weekly performance per strategy.

openclaw cron add \
  --name "brain-weekly-review" \
  --cron "0 10 * * 0" \
  --tz "Europe/Prague" \
  --session isolated \
  --agent brain-trader \
  --message "Generate a weekly strategy review for the Brain Polymarket Bot.

Fetch:
1. ${API_GATEWAY}/api/v1/optimizer/reports?limit=7 — strategy reports
2. ${API_GATEWAY}/api/v1/analyzer/analyses?limit=50 — trade analyses
3. ${API_GATEWAY}/api/v1/replay/summary — replay statistics
4. ${API_GATEWAY}/api/v1/strategies — all strategies

Analyze:
- Weekly P&L breakdown
- Which strategy performed best?
- Win rate trends
- Agent accuracy (edge prediction, regime classification)
- Top rejection reasons from risk service
- Suggestions for parameter tuning

Format as a structured report with sections and key numbers highlighted." \
  --model "openai/gpt-4o" \
  --thinking "high" \
  --announce \
  --enabled

echo "  ✅ Weekly review cron (Sunday 10:00 CET)"

echo ""
echo "🎉 OpenClaw setup complete!"
echo ""
echo "Cron jobs created:"
echo "  • brain-health-check      — every 2 min (unhealthy services)"
echo "  • brain-pnl-report        — every 30 min (P&L summary)"
echo "  • brain-strategy-monitor  — every 15 min (agent decisions)"
echo "  • brain-morning-brief     — daily 8:00 CET (daily brief)"
echo "  • brain-budget-alert      — every 5 min (budget warnings)"
echo "  • brain-restart-detector  — every 10 min (service restarts)"
echo "  • brain-weekly-review     — Sunday 10:00 CET (weekly analysis)"
echo ""
echo "Manage jobs: openclaw cron list"
echo "View runs:   openclaw cron runs"
echo "Dashboard:   openclaw dashboard"
