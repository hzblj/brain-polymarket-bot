# Brain Service

Polymarket BTC 5-minute Up/Down trading bot. Monorepo s 10 NestJS microservices, LLM agenty (Claude/OpenAI) a deterministickymi risk guardrails.

## Architektura

```
[Polymarket API/WS]     [Binance/Coinbase WS]
         |                        |
    market-discovery         price-feed
         |                        |
         +--- orderbook ----------+
                    |
              feature-engine
                    |
              agent-gateway
             /      |      \
     regime-agent  edge   supervisor
                    |
               risk-service
                    |
            execution-service
                    |
              [Polymarket CLOB]
```

**Hlavni zasada:** Services pocitaji realitu. Agenti interpretuju. Risk schvaluje. Execution provadi. LLM nikdy neposlou order.

## Services

| Service | Port | Ucel |
|---------|------|------|
| api-gateway | 3000 | Vstupni bod, proxy, health check, system status |
| market-discovery | 3001 | Detekce aktivnich BTC 5m marketu |
| price-feed | 3002 | BTC cena z resolveru + externich feedu (Binance, Coinbase) |
| orderbook | 3003 | Polymarket orderbook: spread, depth, imbalance, microprice |
| feature-engine | 3004 | Sjednoceni vsech dat do jednoho feature payloadu |
| risk | 3005 | Deterministicke guardrails (max size, daily loss, spread, depth) |
| execution | 3006 | Paper/live ordery na Polymarket |
| config | 3007 | Centralni konfigurace, market config, feature flags, rezimy, reset-defaults |
| agent-gateway | 3008 | Komunikace s Claude/OpenAI, context, decision validate/log, trace log |
| replay | 3009 | Prehravani historickych dat, backtest |

## Shared packages

| Package | Ucel |
|---------|------|
| @brain/types | Sdilene TypeScript typy |
| @brain/schemas | Zod validacni schemata |
| @brain/config | NestJS config modul s Zod validaci env vars |
| @brain/database | Drizzle ORM + SQLite, vsechny tabulky |
| @brain/logger | Pino logger jako NestJS modul |
| @brain/events | Typovany EventBus (14 event typu) |
| @brain/polymarket-client | REST + WebSocket klient pro Polymarket CLOB |
| @brain/exchange-clients | Binance + Coinbase WebSocket price feedy |
| @brain/llm-clients | Claude + OpenAI s validovanym structured outputem |
| @brain/testing | Factories, mocky, test helpers |

## Rezimy

| Rezim | Popis |
|-------|-------|
| `disabled` | Sbira data, nic neobchoduje. Dobry pro prvotni monitoring. |
| `paper` | **Testovaci rezim.** Agenti rozhoduji, risk schvaluje, execution simuluje ordery. Vsechno se uklada do DB pro pozdejsi vyhodnoceni. Zadny realny obchod. |
| `live` | Posilaji se realne ordery na Polymarket. Vyzaduje API klice a wallet. |

## Quick start

### Prerekvizity

- Docker + Docker Compose
- Node.js >= 20 (pro lokalni vyvoj)
- Yarn 4 (`corepack enable`)

### 1. Konfigurace

```bash
cp .env.example .env
```

Pro paper rezim uprav v `.env`:

```env
EXECUTION_MODE=paper

# Pro agent reasoning (volitelne, system funguje i bez):
ANTHROPIC_API_KEY=sk-ant-...
# nebo
OPENAI_API_KEY=sk-...
```

### 2. Spusteni pres Docker

```bash
docker compose up -d
```

Vsech 10 services nastartuje s hot-reload. Kazda zmena v `apps/` nebo `packages/` se automaticky projevi.

```bash
# Logy jedne service
docker compose logs -f risk

# Logy vsech
docker compose logs -f

# Zastaveni
docker compose down
```

### 3. Lokalni spusteni (bez Dockeru)

```bash
yarn install

# Vsechny services najednou (kazda v samostatnem terminalu)
yarn dev:market-discovery
yarn dev:price-feed
yarn dev:orderbook
yarn dev:feature-engine
yarn dev:risk
yarn dev:execution
yarn dev:config
yarn dev:agent-gateway
yarn dev:api-gateway
```

## Paper mode: testovani bez realnch obchodu

Paper mode je hlavni zpusob, jak system testovat. Cely pipeline bezi normalne — jen execution service simuluje ordery misto odeslani na Polymarket.

### Co se deje v paper mode

1. **market-discovery** najde aktivni BTC 5m market
2. **price-feed** sleduje BTC cenu z Binance/Coinbase + resolver proxy
3. **orderbook** drzi stav Polymarket order booku
4. **feature-engine** spocita features (momentum, volatilita, book pressure, tradeability)
5. **agent-gateway** posle features agentum:
   - **Regime agent** → klasifikuje trh (trend_up, trend_down, mean_reversion, high_noise, do_not_trade)
   - **Edge agent** → odhadne ferovou pravdepodobnost UP/DOWN
   - **Supervisor agent** → navrhne trade (BUY_UP / BUY_DOWN / HOLD + velikost + confidence)
6. **risk-service** overi navrhovanou pozici vuci vsem guardrails
7. **execution-service** simuluje fill: vytvori order v DB, zaznamena fill za aktualni cenu, updatne pozici

### Vsechno se uklada

Kazdy krok se uklada do SQLite databaze (`./data/brain.sqlite`):

| Tabulka | Co uklada |
|---------|-----------|
| `market_configs` | Konfigurace marketu (asset, timeframe, resolver) |
| `market_windows` | Kazde 5m okno: start/end cas, start price, vysledek |
| `price_ticks` | Vsechny cenove ticky z externich feedu |
| `book_snapshots` | Snimky order booku |
| `feature_snapshots` | Spocitane feature payloady |
| `agent_decisions` | Vsechna LLM rozhodnuti vcetne promptu, odpovedi a latence |
| `risk_decisions` | Vyhodnoceni risk-service: schvaleno/zamitnuto a duvody |
| `orders` | Vsechny ordery (paper i live) |
| `fills` | Vsechny filly (simulovane i realne) |

### Vyhodnoceni na konci dne

Vsechna data jsou v SQLite, takze je mozne je jednoduse dotazovat:

```bash
# Pripojeni k databazi
sqlite3 ./data/brain.sqlite

# Kolik obchodu dnes
SELECT COUNT(*) FROM orders WHERE date(created_at) = date('now') AND mode = 'paper';

# Paper P&L za dnes
SELECT
  COUNT(*) as trades,
  SUM(CASE WHEN status = 'filled' THEN size_usd ELSE 0 END) as total_volume,
  SUM(CASE WHEN side = 'buy_up' AND entry_price < 0.5 THEN size_usd
           WHEN side = 'buy_down' AND entry_price < 0.5 THEN size_usd
           ELSE -size_usd END) as estimated_pnl
FROM orders
WHERE date(created_at) = date('now') AND mode = 'paper';

# Vsechna rozhodnuti agentu
SELECT agent_type, json_extract(output, '$.action') as action,
       json_extract(output, '$.confidence') as confidence,
       json_extract(output, '$.reasoning') as reason
FROM agent_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
ORDER BY event_time DESC;

# Kolikrat risk zamitnul trade
SELECT approved, COUNT(*) as count,
       GROUP_CONCAT(rejection_reasons) as reasons
FROM risk_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY approved;
```

### Replay service

Pro hromadne vyhodnoceni historickych dat:

```bash
# Spustit replay za casovy interval
curl -X POST http://localhost:3009/api/v1/replay/run \
  -H 'Content-Type: application/json' \
  -d '{"fromTime": 1710900000000, "toTime": 1710986400000}'

# Souhrn vsech replays
curl http://localhost:3009/api/v1/replay/summary
```

## API endpointy

### System status
```bash
# Celkovy stav systemu
curl http://localhost:3000/api/v1/status

# Health check vsech services
curl http://localhost:3000/health
```

### Data
```bash
# Aktualni market
curl http://localhost:3001/api/v1/market/active

# Aktualni cena
curl http://localhost:3002/api/v1/price/current

# Orderbook metriky
curl http://localhost:3003/api/v1/book/metrics

# Feature payload
curl http://localhost:3004/api/v1/features/current
```

### Trading
```bash
# Risk stav
curl http://localhost:3005/api/v1/risk/state

# Kill switch (zastavit vsechno)
curl -X POST http://localhost:3005/api/v1/risk/kill-switch/on

# Pozice
curl http://localhost:3006/api/v1/execution/positions

# Filly
curl http://localhost:3006/api/v1/execution/fills
```

### Konfigurace
```bash
# Aktualni config (vcetne market, trading, risk, provider, feature flags)
curl http://localhost:3007/api/v1/config

# Market config (asset, windowSec, resolver, ...)
curl http://localhost:3007/api/v1/config/market

# Zmena assetu / timeframe
curl -X POST http://localhost:3007/api/v1/config/market \
  -H 'Content-Type: application/json' \
  -d '{"asset": "ETH", "windowSec": 900, "resolver": {"symbol": "ETH/USD"}}'

# Zmena rezimu na paper
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"trading": {"mode": "paper"}}'

# Reset na default Bitcoin 5m preset
curl -X POST http://localhost:3007/api/v1/config/reset-defaults

# Feature flags
curl http://localhost:3007/api/v1/config/feature-flags
```

### Agenti
```bash
# Kontext pro agenty (provider, model, cache, posledni traces)
curl http://localhost:3008/api/v1/agent/context

# Validace agent decision payloadu
curl -X POST http://localhost:3008/api/v1/agent/decision/validate \
  -H 'Content-Type: application/json' \
  -d '{"action": "buy_up", "sizeUsd": 15, "confidence": 0.7, "reasoning": "Strong edge.", "regimeSummary": "Trending up.", "edgeSummary": "8% edge detected."}'

# Zalogovat externi rozhodnuti
curl -X POST http://localhost:3008/api/v1/agent/decision/log \
  -H 'Content-Type: application/json' \
  -d '{"windowId": "win-001", "agentType": "supervisor", "output": {"action": "hold", "sizeUsd": 0, "confidence": 0.5, "reasoning": "No edge."}}'

# Trace log
curl http://localhost:3008/api/v1/agent/traces
curl http://localhost:3008/api/v1/agent/traces/<traceId>
```

## Testy

```bash
# Vsechny testy (334)
npx vitest run

# Testy jedne service
npx vitest run apps/risk-service

# Watch mode
npx vitest
```

## Bezpecnostni pravidla

- Pouze `execution-service` ma pristup k wallet / signing credentials
- `risk-service` je plne deterministicky, nema zadne LLM volani
- `agent-gateway-service` nemuze primo posilat ordery
- Vsechny agent outputy se loguji do `agent_decisions` tabulky
- Kill switch (`POST /api/v1/risk/kill-switch/on`) zastavi vsechno okamzite
- Live mode vyzaduje explicitne `EXECUTION_MODE=live` v env

## TODO

### Napojeni na realna data (stuby → produkce)

- [x] **price-feed-service**: napojeno na realne Binance WebSocket (`btcusdt@bookTicker`) — live bid/ask/mid
- [ ] **price-feed-service**: pridat Coinbase WS jako druhy feed (pro cross-validation)
- [ ] **price-feed-service**: napojit resolver proxy (Chainlink-like source pro Polymarket settlement cenu — ted pouziva Binance mid jako proxy)
- [x] **orderbook-service**: napojeno na Polymarket CLOB REST API (polling `/book?token_id=...` kazdych 2s) — vyzaduje `POLYMARKET_UP_TOKEN_ID` a `POLYMARKET_DOWN_TOKEN_ID` v env, jinak fallback na simulaci
- [x] **market-discovery-service**: napojeno na Polymarket Gamma API pro detekci aktivnich BTC 5m marketu — fallback na stub kdyz zadny market neni nalezen

### Napojeni LLM agentu

- [ ] **agent-gateway-service**: napojit `@brain/llm-clients` v metode `callAgent()` (radek ~417) — ted pouziva stub odpovedi ktere vzdy vraci `hold`
- [ ] Otestovat system prompty na realnych datech a doladit
- [ ] Implementovat hybrid variantu (Claude pro regime/edge, OpenAI pro supervisor)

### Orchestrace a pipeline

- [ ] Implementovat orchestrator ktery propoji cely flow: features → agenti → risk → execution (ted je kazda service samostatna, neni automaticky pipeline)
- [ ] Nastavit triggery pro volani agentu (timeToClose < 90s, delta threshold, tradeability flip)
- [ ] Napojit `@brain/events` EventBus do vsech services (ted pouzivaji stub `emitEvent()`)

### Persistence a monitoring

- [ ] Napojit `@brain/logger` (pino) do vsech services (ted pouzivaji console.log ktery biome odstranil)
- [ ] Dashboard / UI pro sledovani paper trades v realnem case
- [ ] Alerting pri kill switch, daily loss limit, service down

### Live hardening

- [ ] Execution-service: napojit na Polymarket CLOB pro realne ordery
- [ ] Wallet / signing credentials management
- [ ] Oddeleny execution runtime (VPS)
- [ ] Rate limiting na LLM volani
- [ ] Externi DB nebo managed SQLite (Turso/LiteFS) pro produkci

## Struktura monorepa

```
apps/
  api-gateway/                 # Port 3000
  market-discovery-service/    # Port 3001
  price-feed-service/          # Port 3002
  orderbook-service/           # Port 3003
  feature-engine-service/      # Port 3004
  risk-service/                # Port 3005
  execution-service/           # Port 3006
  config-service/              # Port 3007
  agent-gateway-service/       # Port 3008
  replay-service/              # Port 3009

packages/
  types/           # Sdilene TS typy
  schemas/         # Zod schemata
  config/          # NestJS config modul
  database/        # Drizzle ORM + SQLite
  logger/          # Pino logger
  events/          # Typovany EventBus
  polymarket-client/  # Polymarket REST + WS
  exchange-clients/   # Binance + Coinbase WS
  llm-clients/        # Claude + OpenAI
  testing/            # Test utilities
```
