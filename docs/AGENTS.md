# Agenti

System pouziva 3 LLM agenty v realnem case + 1 offline pro analyzu. Agenti **nikdy neposilaji ordery** — navrhnou trade a risk-service + execution-service rozhodnou a provedou.

## Prehled

```
Feature payload (kazdy tick)
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
  Risk Service  →  schvaleno/zamitnuto (deterministicky, bez AI)
       │
       ▼
  Execution     →  paper fill / live order
```

## 1. Regime Agent

Klasifikuje aktualni stav trhu do jednoho z 5 rezimu.

### Rezimy

| Rezim | Kdy nastava | Co to znamena pro trading |
|-------|-------------|---------------------------|
| `trending_up` | Silny pozitivni momentum, bid pressure, rostouci tick rate | Smer nahoru, moznost BUY_UP |
| `trending_down` | Silny negativni momentum, ask pressure, rostouci tick rate | Smer dolu, moznost BUY_DOWN |
| `mean_reverting` | Cena osciluje kolem stredu, zadny jasny trend | Moznost kontra-trade s vysokym confidence |
| `volatile` | Velke swingy obema smery, siroky spread, nizky depth | **Neobchodovat** — prilis velke riziko |
| `quiet` | Nic se nedeje, nizka volatilita, uzky spread | **Neobchodovat** — zadna edge |

### Vstup

- Price: returnBps, momentum, volatility, meanReversionStrength, tickRate
- Book: spreadBps, depthScore, imbalance
- Signals: priceDirectionScore, volatilityRegime, bookPressure, basisSignal
- Cas: remainingMs (kolik zbyva do konce 5m okna)

### Vystup

```json
{
  "regime": "trending_up",
  "confidence": 0.72,
  "reasoning": "BTC showing sustained upward momentum with increasing volume and positive book imbalance."
}
```

### Pravidla

- Confidence 0.3–0.5 = nejasna situace, agent si neni jisty
- Confidence 0.7+ = jasny signal
- Pokud zbyvajici cas < 60s a momentum je nizky → preferuje `quiet`
- Pokud volatilita je extremni a momentum nizky → `volatile` ma prednost pred trending

## 2. Edge Agent

Odhaduje ferovou pravdepodobnost UP/DOWN a porovnava s aktualni cenou na Polymarket.

### Jak to funguje

Na Polymarket UP token plati $1 pokud BTC na konci okna > BTC na zacatku okna. Cena UP tokenu na Polymarket = implied pravdepodobnost trhu.

Agent spocita vlastni odhad P(UP) na zaklade:
- BTC momentum a return od zacatku okna
- Externi cena (Binance, Coinbase) vs Polymarket resolver
- Mean reversion strength
- Book imbalance

Pak porovna s Polymarket cenou:
- Fair P(UP) = 0.64, Polymarket UP mid = 0.57 → **edge 0.07 smerem nahoru**
- Fair P(UP) = 0.48, Polymarket UP mid = 0.52 → **edge 0.04 smerem dolu**

### Vstup

- BTC cena: binancePrice, coinbasePrice, exchangeMidPrice, polymarketMidPrice
- Polymarket book: upBid, upAsk, downBid, downAsk
- Price features: returnBps, momentum, volatility, basisBps
- Signals: priceDirectionScore, volatilityRegime, bookPressure

### Vystup

```json
{
  "direction": "up",
  "magnitude": 0.11,
  "confidence": 0.69,
  "reasoning": "Market implied probability is slightly below fair value while external momentum still supports continuation."
}
```

### Pravidla

- `magnitude < 0.03` → `direction: "none"`, neni co obchodovat
- `magnitude 0.03–0.05` → slaba edge, supervisor ji pravdepodobne ignoruje
- `magnitude 0.05–0.10` → stredni edge, staci pro trade
- `magnitude 0.10+` → silna edge, vetsi pozice
- Vysoka volatilita snizuje confidence v directional callech
- Nizky cas (< 60s) znamena ze momentum ma vetsi vahu
- Velky basis (exchange vs Polymarket) naznacuje mozny mispricing

## 3. Supervisor Agent

Syntetizuje vysledky obou agentu + risk stav do jednoho rozhodnuti. Je posledni rozhodce pred risk checky.

### Rozhodnuti

| Akce | Kdy |
|------|-----|
| `buy_up` | Regime trending_up + edge up + magnitude > 0.05 + confidence > 0.5 + risk OK |
| `buy_down` | Regime trending_down + edge down + magnitude > 0.05 + confidence > 0.5 + risk OK |
| `hold` | Vsechno ostatni (default) |

### Kdy supervisor drzi (HOLD)

- Regime je `volatile` nebo `quiet`
- Edge direction je `none` nebo magnitude < 0.03
- Edge confidence < 0.4
- Denni P&L blizko loss limitu
- Uz se obchodovalo v tomto okne (max 1 trade/window)
- Zbyvajici cas < 30s — prilis pozde na entry
- Spread je prilis siroky vuci edge

### Sizing

| Edge magnitude | Confidence | Zakladni velikost |
|---------------|------------|-------------------|
| 0.05–0.10 | 0.5–0.7 | $10–15 |
| 0.10+ | 0.7+ | $20–30 |
| jakakoli | < 0.6 | scale down |
| jakakoli | negativni denni P&L | scale down |

Maximum: vzdy respektuje `maxSizeUsd` z risk configu (default $50).

### Vstup

- Feature payload (price, book, signals)
- Regime output (od regime agenta)
- Edge output (od edge agenta)
- Risk state: dailyPnlUsd, openPositionUsd, tradesInWindow
- Risk config: maxSizeUsd, dailyLossLimitUsd

### Vystup

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

Pro analyzu historickych rozhodnuti po dni/tydnu. Zatim neni implementovany jako samostatny agent — replay-service muze znovu spustit agenty nad historickymi feature snapshoty a porovnat nova rozhodnuti s puvodnima.

Idealni use case pro slow-path Claude/OpenAI volani:
- Proc agent ziskal/ztratil v konkretnim okne
- Jaky regime byl nejziskovejsi
- Navrhovat nove features nebo pravidla

## Kdy se agenti volaji

Ne na kazdy tick. To by bylo drahe a pomale.

| Trigger | Proc |
|---------|------|
| Otevreni noveho 5m okna | Prvni regime check |
| `timeToClose < 90s` | Cas na trade decision |
| `timeToClose < 45s` | Druhy check — potvrzeni nebo zmena |
| Delta prekroci threshold | Velky pohyb BTC |
| Spread/imbalance se vyrazne zmeni | Book conditions se zmenily |
| Tradeability flip (false → true) | Podminky se zlepsily |

## Provider konfigurace

V `.env`:

```env
# Anthropic (doporuceno pro reasoning)
AGENT_PROVIDER=anthropic
AGENT_MODEL=claude-sonnet-4-20250514
ANTHROPIC_API_KEY=sk-ant-...

# Nebo OpenAI
AGENT_PROVIDER=openai
AGENT_MODEL=gpt-4o
OPENAI_API_KEY=sk-...
```

Zmena za behu bez restartu:

```bash
curl -X POST http://localhost:3007/api/v1/config \
  -H 'Content-Type: application/json' \
  -d '{"provider": {"provider": "anthropic", "model": "claude-sonnet-4-20250514", "temperature": 0}}'
```

## Hybrid varianta

Nejlepsi prakticka varianta je kombinovat providery:

| Agent | Provider | Proc |
|-------|----------|------|
| Regime | Claude | Silny reasoning nad vice signaly |
| Edge | Claude | Kvalitni odhad pravdepodobnosti |
| Supervisor | OpenAI | Structured output, tool orchestrace |
| Replay | Claude | Nejlepsi pro post-hoc analyzu |

## Audit

Vsechna LLM volani se loguji do tabulky `agent_decisions`:
- Kompletni vstup (feature payload)
- Kompletni vystup (JSON rozhodnuti)
- Model, provider, latence, cas
- Pristupne pres `GET /api/v1/agent/traces`

## Aktualni stav

`agent-gateway-service` momentalne pouziva **stub odpovedi** — vzdy vraci `hold`. Pro realne LLM volani je potreba:

1. Nastavit `ANTHROPIC_API_KEY` (nebo `OPENAI_API_KEY`) v `.env`
2. Napojit `@brain/llm-clients` v metode `callAgent` (`agent-gateway.service.ts`, radek ~417)

System prompty pro vsechny 3 agenty uz jsou napsane a otestovane — viz `REGIME_SYSTEM_PROMPT`, `EDGE_SYSTEM_PROMPT`, `SUPERVISOR_SYSTEM_PROMPT` v `agent-gateway.service.ts`.
