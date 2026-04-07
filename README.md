# Brain Polymarket Bot

Polymarket BTC 5-minute Up/Down trading bot. Monorepo with 13 NestJS microservices, LLM agents (Claude/OpenAI), deterministic risk guardrails, and an analytics layer (post-trade analysis + strategy optimization).

## Architecture

```
  ┌─────────────────────────────── DATA SOURCES ───────────────────────────────┐
  │                                                                            │
  │  [Polymarket API/WS]   [Binance Spot WS]   [mempool.space WS]   [Binance Futures]
  │         │                      │                   │               │       │
  │  market-discovery        price-feed         whale-tracker    derivatives-feed
  │         │                      │                   │               │       │
  │         +--- orderbook ────────+                   │               │       │
  │                    │                               │               │       │
  └────────────────────┴───────────────────────────────┴───────────────┘       │
                       │                               │               │
                       ▼                               ▼               ▼
                 ┌──────────────────────────────────────────────────────┐
                 │              feature-engine                          │
                 │  price + book + signals + whales + derivatives       │
                 │  → unified FeaturePayload (1x/sec)                  │
                 └────────────────────┬────────────────────────────────┘
                                      │
                                      ▼
                 ┌─────────────────────────────────────────────────────────┐
                 │              agent-gateway (OpenAI gpt-4o)               │
                 │                                                          │
                 │   regime-agent ──► edge-agent ──► supervisor             │
                 │                                                          │
                 │   4 strategies (selected via strategy-assignment):       │
                 │   ┌─────────────┬──────────────┬─────────────────┐      │
                 │   │  Momentum   │ Mean Revert  │  Basis Arb      │      │
                 │   │  (default)  │ (Citadel)    │  (Jump/HFT)     │      │
                 │   ├─────────────┼──────────────┼─────────────────┤      │
                 │   │  Vol Fade   │              │                 │      │
                 │   │  (Wintermute│              │                 │      │
                 │   └─────────────┴──────────────┴─────────────────┘      │
                 │                                                          │
                 │   All agents receive:                                    │
                 │   • price/book/signals (price data)                      │
                 │   • whales (exchange flow, abnormal activity)            │
                 │   • derivatives (funding, OI, liquidations)              │
                 └────────────────────┬────────────────────────────────────┘
                                      │
                                      ▼
                               risk-service
                          (deterministic guardrails)
                                      │
                                      ▼
                            execution-service ──────► post-trade-analyzer
                                      │                        │
                               [Polymarket CLOB]        strategy-optimizer
                                                        (daily deep analysis)
```

**Core principle:** Services compute reality. Agents interpret. Risk approves. Execution acts. Analyzers learn. LLMs never send orders.

## Services

| Service | Port | Purpose |
|---------|------|---------|
| api-gateway | 3000 | Entry point, proxy, health check, system status |
| market-discovery | 3001 | Detection of active BTC 5m markets |
| price-feed | 3002 | BTC price from resolver + external feeds (Binance, Coinbase) |
| orderbook | 3003 | Polymarket orderbook: spread, depth, imbalance, microprice |
| feature-engine | 3004 | Unification of all data into a single feature payload |
| risk | 3005 | Deterministic guardrails (max size, daily loss, spread, depth) |
| execution | 3006 | Paper/live orders on Polymarket |
| config | 3007 | Central configuration, market config, feature flags, modes, reset-defaults |
| agent-gateway | 3008 | Communication with Claude/OpenAI, context, decision validate/log, trace log |
| replay | 3009 | Replay of historical data, backtest |
| whale-tracker | 3010 | On-chain whale transaction tracking (BTC exchange flows, mempool.space) |
| post-trade-analyzer | 3011 | LLM analysis of each trade (P&L, edge accuracy, misleading signals) |
| strategy-optimizer | 3012 | Daily deep analysis, pattern recognition, strategy adjustment suggestions |
| derivatives-feed | 3013 | Binance Futures: funding rate, open interest, liquidations (WS + REST) |

## Strategies

Each strategy has its own set of system prompts for regime/edge/supervisor agents. Strategy selection is managed via `strategy-assignment` in config-service. The registry in agent-gateway supports multiple profiles — currently only the default set is active.

| Strategy | Profiles | Style | When it trades |
|----------|----------|-------|----------------|
| **Momentum** (default) | regime-default-v1, edge-momentum-v1, supervisor-momentum-v1 | Trend-following | Strong momentum + edge > 5% + regime trending |

### Data inputs for agents

All agents receive the complete FeaturePayload including:
- **Price/book/signals** — price data, orderbook, computed signals
- **Whales** (optional) — exchangeFlowPressure, abnormalActivityScore, whaleVolumeBtc
- **Derivatives** (optional) — fundingPressure, oiTrend, liquidationIntensity/Imbalance, derivativesSentiment

Agents use whale + derivatives data for:
- Confirming/disproving price signals (signal confluence)
- Adjusting confidence (whale flow opposing = -0.15 confidence)
- Detecting dangerous situations (liquidation cascade + opposing edge = HOLD)
- Contrarian signals (extreme funding = crowded positioning)

## Shared packages

| Package | Purpose |
|---------|---------|
| @brain/types | Shared TypeScript types |
| @brain/schemas | Zod validation schemas |
| @brain/config | NestJS config module with Zod env var validation |
| @brain/database | Drizzle ORM + SQLite, all tables |
| @brain/logger | Pino logger as NestJS module |
| @brain/events | Typed EventBus |
| @brain/polymarket-client | REST + WebSocket client for Polymarket CLOB |
| @brain/exchange-clients | Binance + Coinbase WebSocket price feeds |
| @brain/llm-clients | Claude + OpenAI with validated structured output |
| @brain/testing | Factories, mocks, test helpers |

## Modes

| Mode | Description |
|------|-------------|
| `disabled` | Collects data, does not trade. Good for initial monitoring. |
| `paper` | **Test mode.** Agents decide, risk approves, execution simulates orders. Everything is saved to DB for later evaluation. No real trades. |
| `live` | Sends real orders to Polymarket. Requires API keys and wallet. |

## Quick start

### Prerequisites

- Docker + Docker Compose
- Node.js >= 20 (for local development)
- Yarn 4 (`corepack enable`)

### 1. Configuration

```bash
cp .env.example .env
```

For paper mode, edit `.env`:

```env
EXECUTION_MODE=paper

# For agent reasoning (optional, system works without it):
ANTHROPIC_API_KEY=sk-ant-...
# or
OPENAI_API_KEY=sk-...
```

### 2. Running with Docker

```bash
docker compose up -d
```

All services start with hot-reload. Any change in `apps/` or `packages/` is automatically reflected.

```bash
# Logs for a single service
docker compose logs -f risk

# All logs
docker compose logs -f

# Stop
docker compose down
```

### 3. Running locally (without Docker)

```bash
yarn install

# All services at once (each in a separate terminal)
yarn dev:market-discovery
yarn dev:price-feed
yarn dev:orderbook
yarn dev:feature-engine
yarn dev:risk
yarn dev:execution
yarn dev:config
yarn dev:agent-gateway
yarn dev:api-gateway
yarn dev:post-trade-analyzer
yarn dev:strategy-optimizer
```

## Paper mode: testing without real trades

Paper mode is the primary way to test the system. The entire pipeline runs normally — only the execution service simulates orders instead of sending them to Polymarket.

### What happens in paper mode

1. **market-discovery** finds the active BTC 5m market
2. **price-feed** tracks BTC price from Binance/Coinbase + resolver proxy
3. **orderbook** maintains Polymarket order book state
4. **feature-engine** computes features (momentum, volatility, book pressure, tradeability)
5. **agent-gateway** sends features to agents:
   - **Regime agent** — classifies the market (trend_up, trend_down, mean_reversion, high_noise, do_not_trade)
   - **Edge agent** — estimates fair probability of UP/DOWN
   - **Supervisor agent** — proposes a trade (BUY_UP / BUY_DOWN / HOLD + size + confidence)
6. **risk-service** validates the proposed position against all guardrails
7. **execution-service** simulates the fill: creates an order in DB, records fill at current price, updates position

### Everything is persisted

Every step is saved to the SQLite database (`./data/brain.sqlite`):

| Table | What it stores |
|-------|---------------|
| `market_configs` | Market configuration (asset, timeframe, resolver) |
| `market_windows` | Each 5m window: start/end time, start price, outcome |
| `price_ticks` | All price ticks from external feeds |
| `book_snapshots` | Order book snapshots |
| `feature_snapshots` | Computed feature payloads |
| `agent_decisions` | All LLM decisions including prompts, responses, and latency |
| `risk_decisions` | Risk service evaluations: approved/rejected and reasons |
| `orders` | All orders (paper and live) |
| `fills` | All fills (simulated and real) |
| `trade_analyses` | LLM analysis of each trade (P&L, edge accuracy, signals) |
| `daily_reports` | Daily strategy reports (aggregated stats + LLM insights) |

### End-of-day evaluation

All data is in SQLite, so it can be easily queried:

```bash
# Connect to the database
sqlite3 ./data/brain.sqlite

# How many trades today
SELECT COUNT(*) FROM orders WHERE date(created_at) = date('now') AND mode = 'paper';

# Paper P&L for today
SELECT
  COUNT(*) as trades,
  SUM(CASE WHEN status = 'filled' THEN size_usd ELSE 0 END) as total_volume,
  SUM(CASE WHEN side = 'buy_up' AND entry_price < 0.5 THEN size_usd
           WHEN side = 'buy_down' AND entry_price < 0.5 THEN size_usd
           ELSE -size_usd END) as estimated_pnl
FROM orders
WHERE date(created_at) = date('now') AND mode = 'paper';

# All agent decisions
SELECT agent_type, json_extract(output, '$.action') as action,
       json_extract(output, '$.confidence') as confidence,
       json_extract(output, '$.reasoning') as reason
FROM agent_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
ORDER BY event_time DESC;

# How many times risk rejected a trade
SELECT approved, COUNT(*) as count,
       GROUP_CONCAT(rejection_reasons) as reasons
FROM risk_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY approved;
```

### Replay service

For bulk evaluation of historical data:

```bash
# Run replay for a time interval
curl -X POST http://localhost:3009/api/v1/replay/run \
  -H 'Content-Type: application/json' \
  -d '{"fromTime": 1710900000000, "toTime": 1710986400000}'

# Summary of all replays
curl http://localhost:3009/api/v1/replay/summary
```

## API endpoints

### System status
```bash
# Overall system state
curl http://localhost:3000/api/v1/status

# Health check for all services
curl http://localhost:3000/health
```

### Data
```bash
# Current market
curl http://localhost:3001/api/v1/market/active

# Current price
curl http://localhost:3002/api/v1/price/current

# Orderbook metrics
curl http://localhost:3003/api/v1/book/metrics

# Feature payload
curl http://localhost:3004/api/v1/features/current
```

### Trading
```bash
# Risk state
curl http://localhost:3005/api/v1/risk/state

# Kill switch (stop everything)
curl -X POST http://localhost:3005/api/v1/risk/kill-switch/on

# Positions
curl http://localhost:3006/api/v1/execution/positions

# Fills
curl http://localhost:3006/api/v1/execution/fills
```

### Configuration
```bash
# Current config (including market, trading, risk, provider, feature flags)
curl http://localhost:3007/api/v1/config

# Market config (asset, windowSec, resolver, ...)
curl http://localhost:3007/api/v1/config/market

# Change asset / timeframe
curl -X POST http://localhost:3007/api/v1/config/market \
  -H 'Content-Type: application/json' \
  -d '{"asset": "ETH", "windowSec": 900, "resolver": {"symbol": "ETH/USD"}}'

# Switch mode to paper
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"trading": {"mode": "paper"}}'

# Reset to default Bitcoin 5m preset
curl -X POST http://localhost:3007/api/v1/config/reset-defaults

# Feature flags
curl http://localhost:3007/api/v1/config/feature-flags
```

### Agents
```bash
# Context for agents (provider, model, cache, latest traces)
curl http://localhost:3008/api/v1/agent/context

# Validate agent decision payload
curl -X POST http://localhost:3008/api/v1/agent/decision/validate \
  -H 'Content-Type: application/json' \
  -d '{"action": "buy_up", "sizeUsd": 15, "confidence": 0.7, "reasoning": "Strong edge.", "regimeSummary": "Trending up.", "edgeSummary": "8% edge detected."}'

# Log an external decision
curl -X POST http://localhost:3008/api/v1/agent/decision/log \
  -H 'Content-Type: application/json' \
  -d '{"windowId": "win-001", "agentType": "supervisor", "output": {"action": "hold", "sizeUsd": 0, "confidence": 0.5, "reasoning": "No edge."}}'

# Trace log
curl http://localhost:3008/api/v1/agent/traces
curl http://localhost:3008/api/v1/agent/traces/<traceId>
```

### Post-Trade Analysis
```bash
# Analyze a specific trade (after window closes)
curl -X POST http://localhost:3011/api/v1/analyzer/analyze \
  -H 'Content-Type: application/json' \
  -d '{"orderId": "ord-123", "windowId": "win-456"}'

# Analyze all trades in a window
curl -X POST http://localhost:3011/api/v1/analyzer/analyze-window \
  -H 'Content-Type: application/json' \
  -d '{"windowId": "win-456"}'

# List analyses (filters: windowId, verdict, from, to)
curl http://localhost:3011/api/v1/analyzer/analyses
curl http://localhost:3011/api/v1/analyzer/analyses?verdict=unprofitable&limit=20
```

### Strategy Optimization
```bash
# Generate daily report (default: last 24h)
curl -X POST http://localhost:3012/api/v1/optimizer/generate-report \
  -H 'Content-Type: application/json' \
  -d '{}'

# Report for a specific period
curl -X POST http://localhost:3012/api/v1/optimizer/generate-report \
  -H 'Content-Type: application/json' \
  -d '{"periodStart": "2026-03-29T00:00:00Z", "periodEnd": "2026-03-30T00:00:00Z"}'

# List reports
curl http://localhost:3012/api/v1/optimizer/reports

# Scheduler status
curl http://localhost:3012/api/v1/optimizer/status

# Enable/disable automatic scheduler (default: every 24h)
curl -X POST http://localhost:3012/api/v1/optimizer/enable
curl -X POST http://localhost:3012/api/v1/optimizer/disable
```

## Tests

```bash
# All tests (334)
npx vitest run

# Tests for a single service
npx vitest run apps/risk-service

# Watch mode
npx vitest
```

## Security rules

- Only `execution-service` has access to wallet / signing credentials
- `risk-service` is fully deterministic, has no LLM calls
- `agent-gateway-service` cannot directly send orders
- All agent outputs are logged to the `agent_decisions` table
- Kill switch (`POST /api/v1/risk/kill-switch/on`) stops everything immediately
- Live mode requires explicit `EXECUTION_MODE=live` in env

## TODO

### Data

- [ ] Add Coinbase WS as second price feed (for cross-validation)
- [ ] Connect resolver proxy (Chainlink-like source for Polymarket settlement price)

### LLM agents

- [ ] Test system prompts on real data and fine-tune
- [ ] Implement hybrid variant (Claude for regime/edge, OpenAI for supervisor)

### Orchestration

- [ ] Triggers for agent calls (timeToClose < 90s, delta threshold, tradeability flip)
- [ ] Track agent latencies (regime/edge/supervisor p50/p95) and adaptively tune timing constants:
  - `PRE_COMPUTE_LEAD_TIME_SEC` (90s) — how early before window end to start pre-compute
  - Gatekeeper trigger (5s before window opens) — when to fire gatekeeper→risk→execute
  - Goal: running averages of latencies → dynamic thresholds instead of static constants

### Monitoring

- [ ] Connect logger (pino) to older services (price-feed, orderbook, risk, execution)
- [ ] Alerting on kill switch, daily loss limit, service down

### Live hardening

- [ ] Execution-service: connect to Polymarket CLOB for real orders
- [ ] Wallet / signing credentials management
- [ ] Separate execution runtime (VPS)
- [ ] Rate limiting on LLM calls
- [ ] External DB or managed SQLite (Turso/LiteFS) for production

## Monorepo structure

```
apps/
  api-gateway/                    # Port 3000
  market-discovery-service/       # Port 3001
  price-feed-service/             # Port 3002
  orderbook-service/              # Port 3003
  feature-engine-service/         # Port 3004
  risk-service/                   # Port 3005
  execution-service/              # Port 3006
  config-service/                 # Port 3007
  agent-gateway-service/          # Port 3008
  replay-service/                 # Port 3009
  whale-tracker-service/          # Port 3010
  post-trade-analyzer-service/    # Port 3011
  strategy-optimizer-service/     # Port 3012
  pipeline-orchestrator/          # Pipeline orchestration
  dashboard/                      # React monitoring UI

packages/
  types/              # Shared TS types
  schemas/            # Zod schemas
  config/             # NestJS config module
  database/           # Drizzle ORM + SQLite
  logger/             # Pino logger
  events/             # Typed EventBus
  polymarket-client/  # Polymarket REST + WS
  exchange-clients/   # Binance + Coinbase WS
  llm-clients/        # Claude + OpenAI
  testing/            # Test utilities
```
