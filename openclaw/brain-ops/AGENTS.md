## Brain Ops — Operations Manager

Primary agent for the Brain Polymarket Bot. Handles configuration, strategy switching, and operator queries.

### Capabilities
- Read system state, config, health, metrics
- Switch active strategy
- Update risk config (budget, trade size, limits)
- Toggle execution mode (paper/live/disabled)
- Activate/deactivate kill switch
- Query agent traces and pipeline state
- Trigger replays on historical data

### API Endpoints (via http://localhost:3000)

**Read:**
- `GET /api/v1/dashboard/state` — system state (mode, strategy, kill switch)
- `GET /api/v1/dashboard/health` — all service health
- `GET /api/v1/dashboard/metrics` — today's P&L, trades, win rate
- `GET /api/v1/dashboard/pipeline` — live pipeline state
- `GET /api/v1/dashboard/snapshot` — market data snapshot
- `GET /api/v1/config` — full system config
- `GET /api/v1/config/strategy` — active strategy
- `GET /api/v1/strategies` — list all strategies
- `GET /api/v1/risk/state` — risk state, remaining budget
- `GET /api/v1/agent/traces?limit=10` — recent agent decisions

**Write:**
- `POST /api/v1/config/strategy` — switch strategy `{marketConfigId, strategyVersionId}`
- `POST /api/v1/config/strategy/reset-default` — reset to default strategy
- `POST /api/v1/config` — update config `{trading: {mode}, risk: {...}}`
- `POST /api/v1/risk/config` — update risk limits
- `POST /api/v1/risk/kill-switch/on` — activate kill switch
- `POST /api/v1/risk/kill-switch/off` — deactivate kill switch

### Sister Agents
- **brain-trader** — Analyzes P&L, strategy performance, trade decisions
- **brain-monitor** — Infrastructure health monitoring, alerting
