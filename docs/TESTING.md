# Testing brain-polymarket-bot in paper mode

Practical guide on how to start the system, connect to real data, and let it run for days in paper mode — without real trades, but with all decisions saved for evaluation.

## What you need

- Docker + Docker Compose
- OpenClaw (basic setup — for resolver proxy and Polymarket access)
- Optional: Anthropic API key (for LLM agents)

## 1. Setup

```bash
cd brain-polymarket-bot
cp .env.example .env
```

Edit `.env`:

```env
# Paper mode — simulates orders, sends nothing real
EXECUTION_MODE=paper

# Anthropic key for agent reasoning (optional)
# Without it the system collects data and computes features, but agents don't make decisions
ANTHROPIC_API_KEY=sk-ant-...

# Or OpenAI
# AGENT_PROVIDER=openai
# OPENAI_API_KEY=sk-...

# Polymarket API (read-only is enough for paper)
# POLYMARKET_API_KEY=...
# POLYMARKET_API_SECRET=...
# POLYMARKET_API_PASSPHRASE=...
```

## 2. Starting up

```bash
# Start all 10 services
docker compose up -d

# Verify everything is running
docker compose ps
```

You should see 10 containers in "Up" state:

```
brain-api-gateway        Up   0.0.0.0:3000->3000
brain-market-discovery   Up   0.0.0.0:3001->3001
brain-price-feed         Up   0.0.0.0:3002->3002
brain-orderbook          Up   0.0.0.0:3003->3003
brain-feature-engine     Up   0.0.0.0:3004->3004
brain-risk               Up   0.0.0.0:3005->3005
brain-execution          Up   0.0.0.0:3006->3006
brain-config             Up   0.0.0.0:3007->3007
brain-agent-gateway      Up   0.0.0.0:3008->3008
brain-replay             Up   0.0.0.0:3009->3009
```

## 3. Verifying the system works

### Quick health check

```bash
# Full system
curl -s http://localhost:3000/health | python3 -m json.tool

# Active market
curl -s http://localhost:3001/api/v1/market/active | python3 -m json.tool

# Current BTC price
curl -s http://localhost:3002/api/v1/price/current | python3 -m json.tool

# Feature payload (this goes to agents)
curl -s http://localhost:3004/api/v1/features/current | python3 -m json.tool

# Risk state
curl -s http://localhost:3005/api/v1/risk/state | python3 -m json.tool
```

### What to look for

- `market-discovery` returns `status: "open"` — found an active 5m market
- `price-feed` returns `resolver.price` and `external.price` — BTC price from feeds
- `feature-engine` returns `signals.tradeable: true/false` — whether conditions are right for trading
- `risk-service` returns `tradingEnabled: true`, `killSwitchActive: false`

## 4. How it runs

The system behaves as follows:

```
Every 5 minutes a new market window opens
  │
  ├── market-discovery detects the new window
  ├── price-feed tracks BTC price (1 tick/s)
  ├── orderbook tracks Polymarket book (1 snapshot/s)
  │
  ├── feature-engine recomputes features (1x/s)
  │     momentum, volatility, book pressure, tradeability
  │
  ├── When timeToClose < 90s and tradeable = true:
  │     agent-gateway sends features to agents
  │       ├── regime-agent: "trend_up" (confidence 0.72)
  │       ├── edge-agent: "fairUpProb: 0.64, edge: 0.11"
  │       └── supervisor-agent: "TRADE_UP, size: $18, confidence: 0.74"
  │
  ├── risk-service validates the proposal:
  │     ✓ kill switch off
  │     ✓ trading enabled
  │     ✓ size $18 <= max $50
  │     ✓ daily loss limit OK
  │     ✓ data fresh (< 15s)
  │     ✓ spread OK
  │     ✓ depth OK
  │     ✓ 0 trades this window < max 1
  │     → APPROVED, size: $18
  │
  └── execution-service (paper mode):
        → Simulates fill at current price
        → Saves order + fill to DB
        → No real trade on Polymarket
```

## 5. Real-time monitoring

```bash
# Logs for all services (very verbose)
docker compose logs -f

# Just the important services
docker compose logs -f feature-engine agent-gateway risk execution

# Just execution — see paper orders
docker compose logs -f execution

# Positions (what the system "holds")
curl -s http://localhost:3006/api/v1/execution/positions | python3 -m json.tool

# Latest fills
curl -s http://localhost:3006/api/v1/execution/fills | python3 -m json.tool

# Agent traces (what agents decided)
curl -s http://localhost:3008/api/v1/agent/traces | python3 -m json.tool
```

## 6. End-of-day evaluation

Data is in SQLite (`./data/brain.sqlite`). The Docker volume is mapped, so you can access it directly from the host.

```bash
sqlite3 ./data/brain.sqlite
```

### Basic metrics

```sql
-- How many paper trades today
SELECT COUNT(*) as trades,
       SUM(size_usd) as total_volume
FROM orders
WHERE mode = 'paper'
  AND date(created_at) = date('now');

-- Trades by side (UP vs DOWN)
SELECT side, COUNT(*) as count, ROUND(AVG(entry_price), 4) as avg_price
FROM orders
WHERE mode = 'paper' AND date(created_at) = date('now')
GROUP BY side;

-- All fills today
SELECT o.side, o.size_usd, f.fill_price, o.created_at
FROM orders o
JOIN fills f ON f.order_id = o.id
WHERE o.mode = 'paper' AND date(o.created_at) = date('now')
ORDER BY o.created_at;
```

### Agent decisions

```sql
-- What agents proposed
SELECT
  agent_type,
  json_extract(output, '$.action') as action,
  json_extract(output, '$.confidence') as confidence,
  SUBSTR(json_extract(output, '$.reasoning'), 1, 80) as reason,
  datetime(event_time/1000, 'unixepoch') as time
FROM agent_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
ORDER BY event_time DESC
LIMIT 20;

-- Regime distribution (how often the market was in each state)
SELECT
  json_extract(output, '$.regime') as regime,
  COUNT(*) as count,
  ROUND(AVG(json_extract(output, '$.confidence')), 2) as avg_confidence
FROM agent_decisions
WHERE agent_type = 'regime'
  AND date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY regime
ORDER BY count DESC;

-- Average LLM call latency
SELECT agent_type,
       COUNT(*) as calls,
       ROUND(AVG(latency_ms)) as avg_ms,
       MAX(latency_ms) as max_ms
FROM agent_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY agent_type;
```

### Risk evaluation

```sql
-- How many times risk approved vs rejected
SELECT
  CASE WHEN approved THEN 'approved' ELSE 'rejected' END as result,
  COUNT(*) as count
FROM risk_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY approved;

-- Most common rejection reasons
SELECT rejection_reasons, COUNT(*) as count
FROM risk_decisions
WHERE NOT approved
  AND date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY rejection_reasons
ORDER BY count DESC;
```

### Feature quality

```sql
-- Average features for today
SELECT
  ROUND(AVG(json_extract(payload, '$.signals.momentum5s')), 4) as avg_momentum,
  ROUND(AVG(json_extract(payload, '$.signals.volatility30s')), 6) as avg_volatility,
  ROUND(AVG(json_extract(payload, '$.book.spreadBps')), 1) as avg_spread,
  ROUND(AVG(json_extract(payload, '$.book.depthScore')), 3) as avg_depth
FROM feature_snapshots
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now');
```

## 7. Replay (bulk evaluation)

The replay service can replay historical data and re-evaluate agent decisions:

```bash
# Replay the last 24h
curl -X POST http://localhost:3009/api/v1/replay/run \
  -H 'Content-Type: application/json' \
  -d '{
    "fromTime": '$(date -v-1d +%s000)',
    "toTime": '$(date +%s000)',
    "reEvaluateAgents": true
  }'

# Results
curl -s http://localhost:3009/api/v1/replay/summary | python3 -m json.tool
```

## 8. Tuning parameters

Change risk parameters at runtime (no restart needed):

```bash
# Increase max position size
curl -X POST http://localhost:3005/api/v1/risk/config \
  -H 'Content-Type: application/json' \
  -d '{"maxSizeUsd": 30, "maxSpreadBps": 400}'

# Switch to a different model
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"provider": {"model": "claude-sonnet-4-20250514", "temperature": 0.1}}'

# Disable agents and keep only data collection
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"featureFlags": {"agentRegimeEnabled": false, "agentEdgeEnabled": false, "agentSupervisorEnabled": false}}'
```

## 9. Emergency stop

```bash
# Kill switch — immediately stops all trading (data collection continues)
curl -X POST http://localhost:3005/api/v1/risk/kill-switch/on

# Disable kill switch
curl -X POST http://localhost:3005/api/v1/risk/kill-switch/off

# Completely stop all services
docker compose down
```

## 10. Typical testing day

| Time | What to do |
|------|-----------|
| Morning | `docker compose up -d`, verify health check |
| During the day | `docker compose logs -f execution` — watch paper orders |
| Evening | SQL queries on `brain.sqlite` — P&L, agent accuracy, risk stats |
| After a week | Replay service — bulk evaluation, model comparison |

## Troubleshooting

```bash
# Service not responding
docker compose restart risk

# Restart all services
docker compose down && docker compose up -d

# Delete data and start fresh
docker compose down
docker volume rm brain-polymarket-bot_brain-data
docker compose up -d

# Check what's in the DB
sqlite3 ./data/brain.sqlite "SELECT COUNT(*) FROM orders;"

# Check env variables in a container
docker compose exec risk env | grep EXECUTION
```
