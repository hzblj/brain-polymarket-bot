#!/usr/bin/env bash
set -euo pipefail

# ─── OpenClaw Setup for Brain Polymarket Bot ─────────────────────────────────
# Run this after `openclaw onboard` to set up all cron jobs and automations.
# Usage: bash scripts/openclaw-setup.sh
#
# Note: This runs on the Pi where Docker + OpenClaw live.
# API gateway is at localhost:3000 (Docker internal).

echo "🧠 Setting up OpenClaw for Brain Polymarket Bot..."

API_GATEWAY="http://localhost:3000"

# ─── 1. P&L Report — every 30 minutes ──────────────────────────────────────
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
  --announce

echo "  ✅ P&L report cron (every 30 min)"

# ─── 2. Strategy Monitor — every 15 minutes ────────────────────────────────
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
  --announce

echo "  ✅ Strategy monitor cron (every 15 min)"

# ─── 3. Morning Brief — daily at 8:00 AM ───────────────────────────────────
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
  --announce

echo "  ✅ Morning brief cron (daily 8:00 CET)"

# ─── 4. Weekly Strategy Review — Sundays at 10:00 AM ───────────────────────
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
  --announce

echo "  ✅ Weekly review cron (Sunday 10:00 CET)"

# ─── 5. Post-Trade Analysis — every hour ────────────────────────────────────
# Analyzes completed trades, signal quality, confidence calibration.

openclaw cron add \
  --name "brain-post-trade-analysis" \
  --cron "0 * * * *" \
  --session "session:brain-analyst" \
  --agent brain-analyst \
  --message "Analyze recent trades from the Brain Polymarket Bot.

Fetch:
1. ${API_GATEWAY}/api/v1/analyzer/analyses?limit=20 — recent trade analyses
2. ${API_GATEWAY}/api/v1/dashboard/trades/closed — trade outcomes

Summarize:
- Edge prediction accuracy (% correct direction)
- Confidence calibration (do high-confidence trades win more?)
- Top misleading signals
- Top correct signals
- Any actionable improvement suggestions

ONLY report if there are new trades since last check. If no new trades, say nothing." \
  --model "openai/gpt-4o-mini" \
  --announce

echo "  ✅ Post-trade analysis cron (hourly)"

# ─── 6. Whale Activity Alert — every 3 minutes ─────────────────────────────
# Alerts on unusual whale activity that could impact BTC price.

openclaw cron add \
  --name "brain-whale-alert" \
  --cron "*/3 * * * *" \
  --session isolated \
  --agent brain-whale \
  --message "Check for significant whale activity.

Fetch ${API_GATEWAY}/api/v1/whales/current and evaluate:

- If abnormalActivityScore > 0.5: ALERT with details
- If |netExchangeFlowBtc| > 30 BTC: ALERT with direction
- If largeTransactionCount > 5 in current window: ALERT

Also fetch:
- ${API_GATEWAY}/api/v1/whales/transactions?limit=5 for details on notable transactions
- ${API_GATEWAY}/api/v1/whales/blockchain for mempool activity, fee spikes, and on-chain exchange flows

Additional blockchain alerts:
- If fee trend (feeChange) > 50%: ALERT — fee spike may indicate network stress
- If notableTransactions.exchangeInflows.btc > 20: ALERT — large exchange deposit (bearish)

If nothing significant, say NOTHING." \
  --model "openai/gpt-4o-mini" \
  --announce

echo "  ✅ Whale activity alert cron (every 3 min)"

# ─── 7. Derivatives Sentiment — every 5 minutes ───────────────────────────
# Monitors funding rates, liquidations, and derivatives sentiment.

openclaw cron add \
  --name "brain-derivatives-monitor" \
  --cron "*/5 * * * *" \
  --session isolated \
  --agent brain-whale \
  --message "Check derivatives market conditions.

Fetch ${API_GATEWAY}/api/v1/derivatives/current and evaluate:

- If |fundingRate| > 0.02%: ALERT — extreme funding
- If liquidationIntensity > 0.6: ALERT — liquidation cascade
- If |derivativesSentiment| > 0.7: ALERT — strong directional signal

If nothing notable, say NOTHING. Only report actionable signals." \
  --model "openai/gpt-4o-mini" \
  --announce

echo "  ✅ Derivatives monitor cron (every 5 min)"

# ─── 8. Market Sentiment Composite — every 10 minutes ─────────────────────
# Combines whale + derivatives + market data for composite sentiment.

openclaw cron add \
  --name "brain-sentiment-composite" \
  --cron "*/10 * * * *" \
  --session "session:brain-sentiment" \
  --agent brain-whale \
  --message "Generate composite market sentiment.

Fetch in parallel:
1. ${API_GATEWAY}/api/v1/whales/current — whale features
2. ${API_GATEWAY}/api/v1/derivatives/current — derivatives features
3. ${API_GATEWAY}/api/v1/dashboard/snapshot — market prices
4. ${API_GATEWAY}/api/v1/dashboard/pipeline — current agent decision
5. ${API_GATEWAY}/api/v1/whales/blockchain — on-chain activity (mempool, fees, exchange flows)

Compute sentiment score from:
- Exchange flow pressure (20%)
- Funding pressure inverted (20%)
- Liquidation imbalance inverted (15%)
- OI trend aligned with price (15%)
- Whale abnormality × flow direction (15%)
- Blockchain on-chain confirmation (15%) — fee trends + exchange inflows/outflows from mempool

ONLY report if:
- Composite score > 0.5 or < -0.5 (strong signal)
- OR sentiment CONTRADICTS current agent decision direction
Otherwise say nothing." \
  --model "openai/gpt-4o-mini" \
  --announce

echo "  ✅ Sentiment composite cron (every 10 min)"

echo ""
echo "🎉 OpenClaw setup complete!"
echo ""
echo "Cron jobs created (8 total):"
echo ""
echo "  📈 brain-trader:"
echo "    • brain-pnl-report          — every 30 min (P&L summary)"
echo "    • brain-strategy-monitor    — every 15 min (agent decisions)"
echo "    • brain-morning-brief       — daily 8:00   (daily brief)"
echo "    • brain-weekly-review       — Sunday 10:00 (weekly analysis)"
echo ""
echo "  🔬 brain-analyst:"
echo "    • brain-post-trade-analysis — hourly        (trade analysis)"
echo ""
echo "  🐋 brain-whale:"
echo "    • brain-whale-alert         — every 3 min  (whale activity)"
echo "    • brain-derivatives-monitor — every 5 min  (funding/liqs)"
echo "    • brain-sentiment-composite — every 10 min (composite signal)"
echo ""
echo "Manage jobs: openclaw cron list"
echo "View runs:   openclaw cron runs"
