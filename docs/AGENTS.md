# Agents

The system uses 3 real-time LLM agents + 1 offline agent for analysis. Agents **never send orders** — they propose trades and the risk-service + execution-service decide and execute.

## Overview

```
Feature payload (every tick)
       │
       ▼
  Regime Agent  →  "trending_up, confidence 0.72"
       │
       ▼
  Edge Agent    →  "up, magnitude 0.11, confidence 0.69"
       │
       ▼
  Supervisor    →  "BUY_UP, $18, confidence 0.74"
       │
       ▼
  Risk Service  →  approved/rejected (deterministic, no AI)
       │
       ▼
  Execution     →  paper fill / live order
```

## 1. Regime Agent

Classifies the current market state into one of 5 regimes.

### Regimes

| Regime | When it occurs | What it means for trading |
|--------|----------------|--------------------------|
| `trending_up` | Strong positive momentum, bid pressure, rising tick rate | Direction up, possible BUY_UP |
| `trending_down` | Strong negative momentum, ask pressure, rising tick rate | Direction down, possible BUY_DOWN |
| `mean_reverting` | Price oscillating around midpoint, no clear trend | Possible counter-trade with high confidence |
| `volatile` | Large swings in both directions, wide spread, low depth | **Do not trade** — too much risk |
| `quiet` | Nothing happening, low volatility, tight spread | **Do not trade** — no edge |

### Input

- Price: returnBps, momentum, volatility, meanReversionStrength, tickRate
- Book: spreadBps, depthScore, imbalance
- Signals: priceDirectionScore, volatilityRegime, bookPressure, basisSignal
- Time: remainingMs (time left until end of 5m window)

### Output

```json
{
  "regime": "trending_up",
  "confidence": 0.72,
  "reasoning": "BTC showing sustained upward momentum with increasing volume and positive book imbalance."
}
```

### Rules

- Confidence 0.3–0.5 = unclear situation, agent is uncertain
- Confidence 0.7+ = clear signal
- If remaining time < 60s and momentum is low → prefers `quiet`
- If volatility is extreme and momentum is low → `volatile` takes priority over trending

## 2. Edge Agent

Estimates fair probability of UP/DOWN and compares with the current Polymarket price.

### How it works

On Polymarket, the UP token pays $1 if BTC at window end > BTC at window start. The UP token price on Polymarket = market's implied probability.

The agent computes its own estimate of P(UP) based on:
- BTC momentum and return since window start
- External price (Binance, Coinbase) vs Polymarket resolver
- Mean reversion strength
- Book imbalance

Then compares with the Polymarket price:
- Fair P(UP) = 0.64, Polymarket UP mid = 0.57 → **edge 0.07 to the upside**
- Fair P(UP) = 0.48, Polymarket UP mid = 0.52 → **edge 0.04 to the downside**

### Input

- BTC price: binancePrice, coinbasePrice, exchangeMidPrice, polymarketMidPrice
- Polymarket book: upBid, upAsk, downBid, downAsk
- Price features: returnBps, momentum, volatility, basisBps
- Signals: priceDirectionScore, volatilityRegime, bookPressure

### Output

```json
{
  "direction": "up",
  "magnitude": 0.11,
  "confidence": 0.69,
  "reasoning": "Market implied probability is slightly below fair value while external momentum still supports continuation."
}
```

### Rules

- `magnitude < 0.03` → `direction: "none"`, nothing to trade
- `magnitude 0.03–0.05` → weak edge, supervisor will likely ignore it
- `magnitude 0.05–0.10` → medium edge, sufficient for a trade
- `magnitude 0.10+` → strong edge, larger position
- High volatility reduces confidence in directional calls
- Low time (< 60s) means momentum carries more weight
- Large basis (exchange vs Polymarket) suggests possible mispricing

## 3. Supervisor Agent

Synthesizes results from both agents + risk state into a single decision. It is the final arbiter before risk checks.

### Decisions

| Action | When |
|--------|------|
| `buy_up` | Regime trending_up + edge up + magnitude > 0.05 + confidence > 0.5 + risk OK |
| `buy_down` | Regime trending_down + edge down + magnitude > 0.05 + confidence > 0.5 + risk OK |
| `hold` | Everything else (default) |

### When supervisor holds (HOLD)

- Regime is `volatile` or `quiet`
- Edge direction is `none` or magnitude < 0.03
- Edge confidence < 0.4
- Daily P&L close to loss limit
- Already traded in this window (max 1 trade/window)
- Remaining time < 30s — too late for entry
- Spread is too wide relative to edge

### Sizing

| Edge magnitude | Confidence | Base size |
|---------------|------------|-----------|
| 0.05–0.10 | 0.5–0.7 | $10–15 |
| 0.10+ | 0.7+ | $20–30 |
| any | < 0.6 | scale down |
| any | negative daily P&L | scale down |

Maximum: always respects `maxSizeUsd` from risk config (default $50).

### Input

- Feature payload (price, book, signals)
- Regime output (from regime agent)
- Edge output (from edge agent)
- Risk state: dailyPnlUsd, openPositionUsd, tradesInWindow
- Risk config: maxSizeUsd, dailyLossLimitUsd

### Output

```json
{
  "action": "buy_up",
  "sizeUsd": 18,
  "confidence": 0.74,
  "reasoning": "Regime is trending up with strong momentum. Edge agent identified 11% mispricing favoring UP. Risk state is healthy with no prior trades this window.",
  "regimeSummary": "Trending up with 0.72 confidence.",
  "edgeSummary": "UP edge at 0.11 magnitude with 0.69 confidence."
}
```

## 4. Replay/Research Agent (offline)

For analysis of historical decisions after a day/week. Not yet implemented as a standalone agent — the replay-service can re-run agents on historical feature snapshots and compare new decisions with the originals.

Ideal use case for slow-path Claude/OpenAI calls:
- Why the agent won/lost in a specific window
- Which regime was most profitable
- Suggesting new features or rules

## When agents are called

Not on every tick. That would be expensive and slow.

| Trigger | Why |
|---------|-----|
| New 5m window opens | First regime check |
| `timeToClose < 90s` | Time for a trade decision |
| `timeToClose < 45s` | Second check — confirmation or change |
| Delta exceeds threshold | Large BTC move |
| Spread/imbalance changes significantly | Book conditions changed |
| Tradeability flip (false → true) | Conditions improved |

## Provider configuration

In `.env`:

```env
# Anthropic (recommended for reasoning)
AGENT_PROVIDER=anthropic
AGENT_MODEL=claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-...

# Or OpenAI
AGENT_PROVIDER=openai
AGENT_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

Runtime change without restart:

```bash
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"provider": {"provider": "anthropic", "model": "claude-sonnet-4-20250514", "temperature": 0}}'
```

## Hybrid variant

The best practical variant is combining providers:

| Agent | Provider | Why |
|-------|----------|-----|
| Regime | Claude | Strong reasoning across multiple signals |
| Edge | Claude | Quality probability estimation |
| Supervisor | OpenAI | Structured output, tool orchestration |
| Replay | Claude | Best for post-hoc analysis |

## Audit

All LLM calls are logged to the `agent_decisions` table:
- Complete input (feature payload)
- Complete output (JSON decision)
- Model, provider, latency, timestamp
- Accessible via `GET /api/v1/agent/traces`

## Current state

`agent-gateway-service` currently uses **stub responses** — always returns `hold`. For real LLM calls you need to:

1. Set `ANTHROPIC_API_KEY` (or `OPENAI_API_KEY`) in `.env`
2. Connect `@brain/llm-clients` in the `callAgent` method (`agent-gateway.service.ts`, line ~417)

System prompts for all 3 agents are already written and tested — see `REGIME_SYSTEM_PROMPT`, `EDGE_SYSTEM_PROMPT`, `SUPERVISOR_SYSTEM_PROMPT` in `agent-gateway.service.ts`.
