# Testovani brain-service v paper mode

Prakticky navod jak rozjet system, napojit na realna data a nechat ho cele dny bezet v paper mode — bez realnch obchodu, ale se vsemi rozhodnutimi ulozenymi pro vyhodnoceni.

## Co je potreba

- Docker + Docker Compose
- OpenClaw (basic setup — pro resolver proxy a Polymarket pristup)
- Volitelne: Anthropic API klic (pro LLM agenty)

## 1. Priprava

```bash
cd brain-service
cp .env.example .env
```

Uprav `.env`:

```env
# Paper mode — simuluje ordery, nic realne neposila
EXECUTION_MODE=paper

# Anthropic klic pro agent reasoning (volitelne)
# Bez nej system sbira data a pocita features, ale agenti nerozhoduji
ANTHROPIC_API_KEY=sk-ant-...

# Nebo OpenAI
# AGENT_PROVIDER=openai
# OPENAI_API_KEY=sk-...

# Polymarket API (read-only staci pro paper)
# POLYMARKET_API_KEY=...
# POLYMARKET_API_SECRET=...
# POLYMARKET_API_PASSPHRASE=...
```

## 2. Spusteni

```bash
# Start vsech 10 services
docker compose up -d

# Over ze vsechno bezi
docker compose ps
```

Melo by byt 10 kontejneru ve stavu "Up":

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

## 3. Overeni ze system funguje

### Rychly health check

```bash
# Cely system
curl -s http://localhost:3000/health | python3 -m json.tool

# Aktivni market
curl -s http://localhost:3001/api/v1/market/active | python3 -m json.tool

# Aktualni cena BTC
curl -s http://localhost:3002/api/v1/price/current | python3 -m json.tool

# Feature payload (tohle jde do agentu)
curl -s http://localhost:3004/api/v1/features/current | python3 -m json.tool

# Risk stav
curl -s http://localhost:3005/api/v1/risk/state | python3 -m json.tool
```

### Co hledat

- `market-discovery` vraci `status: "open"` — naslo aktivni 5m market
- `price-feed` vraci `resolver.price` a `external.price` — BTC cena z fedu
- `feature-engine` vraci `signals.tradeable: true/false` — jestli jsou podminky pro trade
- `risk-service` vraci `tradingEnabled: true`, `killSwitchActive: false`

## 4. Jak to bezi

System se chova nasledovne:

```
Kazdych 5 minut se otevre novy market window
  │
  ├── market-discovery detekuje novy window
  ├── price-feed sleduje BTC cenu (1 tick/s)
  ├── orderbook sleduje Polymarket book (1 snapshot/s)
  │
  ├── feature-engine prepocita features (1x/s)
  │     momentum, volatilita, book pressure, tradeability
  │
  ├── Kdyz timeToClose < 90s a tradeable = true:
  │     agent-gateway posle features agentum
  │       ├── regime-agent: "trend_up" (confidence 0.72)
  │       ├── edge-agent: "fairUpProb: 0.64, edge: 0.11"
  │       └── supervisor-agent: "TRADE_UP, size: $18, confidence: 0.74"
  │
  ├── risk-service overi navrh:
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
        → Simuluje fill za aktualni cenu
        → Ulozi order + fill do DB
        → Zadny realny obchod na Polymarket
```

## 5. Sledovani v realnem case

```bash
# Logy vsech services (hodne verbose)
docker compose logs -f

# Jen dulezite services
docker compose logs -f feature-engine agent-gateway risk execution

# Jen execution — vidis paper ordery
docker compose logs -f execution

# Pozice (co system "drzi")
curl -s http://localhost:3006/api/v1/execution/positions | python3 -m json.tool

# Posledni filly
curl -s http://localhost:3006/api/v1/execution/fills | python3 -m json.tool

# Agent traces (co agenti rozhodli)
curl -s http://localhost:3008/api/v1/agent/traces | python3 -m json.tool
```

## 6. Vyhodnoceni na konci dne

Data jsou v SQLite (`./data/brain.sqlite`). Docker volume je namapovany, takze pristup mas primo z hostu.

```bash
sqlite3 ./data/brain.sqlite
```

### Zakladni metriky

```sql
-- Kolik paper obchodu dnes
SELECT COUNT(*) as trades,
       SUM(size_usd) as total_volume
FROM orders
WHERE mode = 'paper'
  AND date(created_at) = date('now');

-- Obchody po strane (UP vs DOWN)
SELECT side, COUNT(*) as count, ROUND(AVG(entry_price), 4) as avg_price
FROM orders
WHERE mode = 'paper' AND date(created_at) = date('now')
GROUP BY side;

-- Vsechny filly dnes
SELECT o.side, o.size_usd, f.fill_price, o.created_at
FROM orders o
JOIN fills f ON f.order_id = o.id
WHERE o.mode = 'paper' AND date(o.created_at) = date('now')
ORDER BY o.created_at;
```

### Agent rozhodnuti

```sql
-- Co agenti navrhovali
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

-- Distribuece rezimu (jak casto byl trh v jakem stavu)
SELECT
  json_extract(output, '$.regime') as regime,
  COUNT(*) as count,
  ROUND(AVG(json_extract(output, '$.confidence')), 2) as avg_confidence
FROM agent_decisions
WHERE agent_type = 'regime'
  AND date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY regime
ORDER BY count DESC;

-- Prumerna latence LLM volani
SELECT agent_type,
       COUNT(*) as calls,
       ROUND(AVG(latency_ms)) as avg_ms,
       MAX(latency_ms) as max_ms
FROM agent_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY agent_type;
```

### Risk vyhodnoceni

```sql
-- Kolikrat risk schvalil vs zamitnul
SELECT
  CASE WHEN approved THEN 'schvaleno' ELSE 'zamitnuto' END as vysledek,
  COUNT(*) as count
FROM risk_decisions
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY approved;

-- Nejcastejsi duvody zamitnutí
SELECT rejection_reasons, COUNT(*) as count
FROM risk_decisions
WHERE NOT approved
  AND date(datetime(event_time/1000, 'unixepoch')) = date('now')
GROUP BY rejection_reasons
ORDER BY count DESC;
```

### Feature quality

```sql
-- Prumerne features za dnesek
SELECT
  ROUND(AVG(json_extract(payload, '$.signals.momentum5s')), 4) as avg_momentum,
  ROUND(AVG(json_extract(payload, '$.signals.volatility30s')), 6) as avg_volatility,
  ROUND(AVG(json_extract(payload, '$.book.spreadBps')), 1) as avg_spread,
  ROUND(AVG(json_extract(payload, '$.book.depthScore')), 3) as avg_depth
FROM feature_snapshots
WHERE date(datetime(event_time/1000, 'unixepoch')) = date('now');
```

## 7. Replay (hromadne vyhodnoceni)

Replay service muze prehrat historicka data a znovu vyhodnotit agent rozhodnuti:

```bash
# Replay poslednich 24h
curl -X POST http://localhost:3009/api/v1/replay/run \
  -H 'Content-Type: application/json' \
  -d '{
    "fromTime": '$(date -v-1d +%s000)',
    "toTime": '$(date +%s000)',
    "reEvaluateAgents": true
  }'

# Vysledek
curl -s http://localhost:3009/api/v1/replay/summary | python3 -m json.tool
```

## 8. Ladeni parametru

Zmena risk parametru za behu (bez restartu):

```bash
# Zvysit max velikost pozice
curl -X POST http://localhost:3005/api/v1/risk/config \
  -H 'Content-Type: application/json' \
  -d '{"maxSizeUsd": 30, "maxSpreadBps": 400}'

# Zmena na jiny model
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"provider": {"model": "claude-sonnet-4-20250514", "temperature": 0.1}}'

# Vypnout agenty a nechat jen data collection
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"featureFlags": {"agentRegimeEnabled": false, "agentEdgeEnabled": false, "agentSupervisorEnabled": false}}'
```

## 9. Nouzove zastaveni

```bash
# Kill switch — okamzite zastaveni vsech obchodu (data se dal sbiraji)
curl -X POST http://localhost:3005/api/v1/risk/kill-switch/on

# Zruseni kill switche
curl -X POST http://localhost:3005/api/v1/risk/kill-switch/off

# Uplne zastaveni vsech services
docker compose down
```

## 10. Typicky den testovani

| Cas | Co udelat |
|-----|-----------|
| Rano | `docker compose up -d`, over health check |
| Pres den | `docker compose logs -f execution` — sleduj paper ordery |
| Vecer | SQL dotazy na `brain.sqlite` — P&L, agent accuracy, risk stats |
| Po tydnu | Replay service — hromadne vyhodnoceni, srovnani modelu |

## Troubleshooting

```bash
# Service nereaguje
docker compose restart risk

# Vsechny services znovu
docker compose down && docker compose up -d

# Smazat data a zacit od nuly
docker compose down
docker volume rm brain-service_brain-data
docker compose up -d

# Overit co je v DB
sqlite3 ./data/brain.sqlite "SELECT COUNT(*) FROM orders;"

# Overit env promenne v kontejneru
docker compose exec risk env | grep EXECUTION
```
