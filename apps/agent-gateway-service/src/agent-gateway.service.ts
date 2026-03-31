import { agentDecisions, DATABASE_CLIENT, type DbClient } from '@brain/database';
import { type BrainEventName, type BrainEventMap, EventBus } from '@brain/events';
import { type LlmClient, OpenAIClient } from '@brain/llm-clients';
import { BrainLoggerService } from '@brain/logger';
import { EdgeOutputSchema, RegimeOutputSchema, SupervisorOutputSchema } from '@brain/schemas';
import type {
  AgentType,
  EdgeOutput,
  FeaturePayload,
  RegimeOutput,
  RiskConfig,
  RiskState,
  SupervisorOutput,
  UnixMs,
} from '@brain/types';
import { HttpException, HttpStatus, Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { z } from 'zod';

// ─── System Prompts ──────────────────────────────────────────────────────────

// ─── Regime Prompts ─────────────────────────────────────────────────────────

export const REGIME_SYSTEM_PROMPT = `You are a market regime classification agent for a Polymarket BTC 5-minute binary options trading system.

Your job: analyze the provided feature snapshot and classify the current market regime into exactly one category.

## Regime Categories

- **trending_up**: BTC price shows sustained upward momentum. Indicators: positive momentum score, positive return over the window, increasing tick rate, bid-side book pressure.
- **trending_down**: BTC price shows sustained downward momentum. Indicators: negative momentum score, negative return over the window, increasing tick rate, ask-side book pressure.
- **mean_reverting**: Price oscillates around a mean with no clear directional trend. Indicators: high mean reversion strength, low absolute momentum, mixed book pressure, moderate volatility.
- **volatile**: High uncertainty with rapid price swings in both directions. Indicators: high volatility, high tick rate, wide spreads, low depth scores. This regime is dangerous for directional bets.
- **quiet**: Very low activity and price movement. Indicators: low volatility, low tick rate, narrow spreads, neutral book pressure. Edges are unlikely in this regime.

## Analysis Framework

1. Examine the price features: returnBps, momentum, volatility, meanReversionStrength, tickRate
2. Examine the book features: spreadBps, depthScore, imbalance, bidDepthUsd, askDepthUsd — low liquidity (total depth < $500) means high slippage risk and regime uncertainty
3. Examine the signal features: priceDirectionScore, volatilityRegime, bookPressure, basisSignal
4. Examine the basis between exchange mid price and Polymarket mid price
5. Consider how much time remains in the window (remainingMs) — regimes can shift as windows close
6. If whale data is present: large exchange inflows (exchangeFlowPressure > 0.3) suggest selling pressure (bearish); large outflows (< -0.3) suggest accumulation (bullish); high abnormalActivityScore (> 0.5) increases volatility classification likelihood
7. If derivatives data is present: extreme funding rates (fundingPressure > 0.5 or < -0.5) indicate crowded positioning ripe for reversal; high liquidationIntensity (> 0.5) signals cascading liquidations that accelerate the current move; derivativesSentiment provides a composite read (-1 bearish to +1 bullish)
8. If blockchain data is present: examine mempool congestion (high txCount + rising fees = network stress, potentially volatile); check notable transaction flows — heavy exchange inflows are bearish, heavy outflows are bullish; elevated fee rates (fastest > 30 sat/vB) indicate urgency/panic; use trend data to see if activity is accelerating vs previous hour

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "regime": "trending_up" | "trending_down" | "mean_reverting" | "volatile" | "quiet",
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences explaining the classification>"
}

Rules:
- Confidence should reflect how clearly the data fits the regime. If ambiguous, use 0.3-0.5.
- If volatility is extreme (regime "high") AND momentum is low, prefer "volatile" over trending.
- If remaining time is under 60 seconds, bias toward "quiet" unless momentum is very strong.
- Never fabricate data points. Only reference values present in the input.`;

export const EDGE_SYSTEM_PROMPT = `You are an edge estimation agent for a Polymarket BTC 5-minute binary options trading system.

Your job: estimate the fair probability that BTC will be UP vs DOWN at window expiry, and determine if there is a tradeable edge against the current Polymarket prices.

## Context

On Polymarket, the "UP" token pays $1 if BTC price at window end > BTC price at window start, and $0 otherwise. The "DOWN" token is the complement. You are given the current orderbook prices (upBid, upAsk, downBid, downAsk) and the feature payload with real-time market data.

## Analysis Framework

1. **Directional probability**: Use price momentum, return since window open, mean reversion strength, and exchange price movements to estimate P(UP).
2. **Market price**: The Polymarket mid price for UP is approximately (upBid + upAsk) / 2. This is the market's implied probability.
3. **Edge**: edge = |fair_probability - market_probability|. Only flag an edge if it exceeds a meaningful threshold (typically 5+ cents / 5%).
4. **Direction**: If your fair P(UP) > market P(UP), direction is "up". If fair P(UP) < market P(UP), direction is "down". If no meaningful edge, direction is "none".
5. **Adjustments**:
   - High volatility reduces confidence in directional calls
   - Low time remaining (< 60s) means momentum carries more weight
   - Large basis between exchange and Polymarket suggests possible mispricing
   - Low depth scores mean edge may not be executable
6. **On-chain whale data** (if present in input):
   - exchangeFlowPressure > 0.3 = net inflow to exchanges = bearish pressure (sellers preparing)
   - exchangeFlowPressure < -0.3 = net outflow from exchanges = bullish (hodling)
   - Whale activity confirms or contradicts the price-based edge — use it to adjust confidence
   - High abnormalActivityScore (> 0.5) means unusual whale activity — weight this signal more
7. **Derivatives data** (if present in input):
   - fundingPressure > 0.3 = longs are crowded = contrarian bearish signal (potential reversal down)
   - fundingPressure < -0.3 = shorts are crowded = contrarian bullish signal
   - liquidationImbalance > 0 = longs getting liquidated = confirms/accelerates downward move
   - liquidationImbalance < 0 = shorts getting liquidated = confirms/accelerates upward move
   - High liquidationIntensity (> 0.5) = liquidation cascade in progress — STRONG directional signal
   - derivativesSentiment provides a composite: positive = bullish, negative = bearish
8. **Blockchain on-chain data** (if present in input):
   - Notable transaction flows: exchangeInflows.btc vs exchangeOutflows.btc — net inflows are bearish (selling prep), net outflows are bullish (accumulation)
   - Mempool congestion (high txCount, rising fees) suggests network urgency which often correlates with volatility
   - Fee spike (fastest > 30 sat/vB) indicates panic or urgency — can confirm momentum in either direction
   - Trend data shows if activity is accelerating (volumeChange > 30% = unusual activity)
   - Use blockchain signals as confirmation/contradiction of the price-based edge
9. **Liquidity**: Low book depth (bidDepthUsd + askDepthUsd < $500) means orders will move the market — reduce edge magnitude for thin books

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "direction": "up" | "down" | "none",
  "magnitude": <number 0-1, how large the edge is in probability terms>,
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences explaining the edge assessment>"
}

Rules:
- If no clear edge exists (magnitude < 0.03), set direction to "none" and magnitude to 0.
- Confidence reflects how certain you are about the edge, NOT the direction of BTC.
- A 0.05 edge at 0.8 confidence is a strong signal. A 0.15 edge at 0.3 confidence is weak.
- Be conservative. Most 5-minute windows have no meaningful edge.
- Never fabricate data. Only reference values present in the input.`;

export const SUPERVISOR_SYSTEM_PROMPT = `You are the supervisor agent for a Polymarket BTC 5-minute binary options trading system.

Your job: synthesize the regime classification, edge assessment, and risk state into a single trade decision. You are the final decision maker before risk checks.

## Input

You receive:
1. **Feature payload**: Full real-time market data
2. **Regime output**: Classification from the regime agent (trending_up/trending_down/mean_reverting/volatile/quiet)
3. **Edge output**: Edge assessment from the edge agent (direction, magnitude, confidence)
4. **Risk state**: Current daily P&L, open exposure, trades this window, risk config limits

## Decision Framework

### When to BUY_UP:
- Regime is trending_up AND edge direction is "up" with magnitude > 0.05 and confidence > 0.5
- OR: Regime is mean_reverting AND price has fallen significantly AND edge direction is "up" with high confidence
- Risk state allows: daily loss limit not breached, position size within limits

### When to BUY_DOWN:
- Regime is trending_down AND edge direction is "down" with magnitude > 0.05 and confidence > 0.5
- OR: Regime is mean_reverting AND price has risen significantly AND edge direction is "down" with high confidence
- Risk state allows: daily loss limit not breached, position size within limits

### When to HOLD (no trade):
- Regime is "volatile" — too much uncertainty
- Regime is "quiet" — no edge to capture
- Edge direction is "none" or magnitude < 0.03
- Edge confidence < 0.4
- Risk state is stressed: daily P&L near loss limit, too many trades this window
- Remaining time < 30 seconds — too late to enter
- Spread is too wide relative to edge
- Whale abnormalActivityScore > 0.7 AND whale flow contradicts the edge direction — conflicting signals, stay out
- Derivatives liquidationIntensity > 0.7 AND liquidation direction contradicts edge — dangerous cascade

### Signal Confluence (use to boost or reduce confidence):
- All signals aligned (price + whales + derivatives + blockchain) → increase confidence by 0.1, allow larger size
- Whale flow contradicts price action → reduce confidence by 0.15
- Liquidation cascade confirms direction → strong signal, treat as high-confidence setup
- Extreme funding rate (|fundingPressure| > 0.5) opposing your trade direction → contrarian warning, reduce size
- Blockchain exchange flows confirm whale data → stronger signal; blockchain contradicts → weaker
- High mempool fees (fastest > 30 sat/vB) + volume spike → network stress, increase volatility estimate
- Low book liquidity (bidDepthUsd + askDepthUsd < $500) → reduce position size, high slippage risk

### Position Sizing:
- Base size: $0.25-0.40 for moderate edges (0.05-0.10 magnitude)
- Larger size: $0.50 for strong edges (0.10+ magnitude, 0.7+ confidence)
- Maximum: respect the maxSizeUsd from risk config (typically $0.50)
- Scale down if daily P&L is negative
- Scale down if confidence is below 0.6

## Output Format

Respond with ONLY a JSON object (no markdown, no explanation outside the JSON):
{
  "action": "buy_up" | "buy_down" | "hold",
  "sizeUsd": <number, 0 if hold>,
  "confidence": <number 0-1>,
  "reasoning": "<2-4 sentences explaining the decision>",
  "regimeSummary": "<1 sentence summarizing the regime context>",
  "edgeSummary": "<1 sentence summarizing the edge assessment>"
}

Rules:
- Default to HOLD. Only trade when regime, edge, and risk all align.
- Never exceed maxSizeUsd from risk config.
- If sizeUsd > 0 but action is "hold", that is invalid. Size must be 0 for hold.
- Be honest in reasoning. If the edge is marginal, say so.
- You do NOT place orders. You propose a trade. The risk service and execution service handle the rest.
- Never fabricate data. Only reference values from the input.`;

// ─── Mean Reversion Prompts (Citadel / Renaissance style) ───────────────────

export const REGIME_MEAN_REVERSION_PROMPT = `You are a market regime classification agent specialized in detecting overextended moves and mean-reversion setups in a Polymarket BTC 5-minute binary options system.

Your job: determine whether the current price action represents a sustainable trend or a temporary overextension likely to revert.

## Regime Categories

- **overextended_up**: BTC price has surged too far too fast within the window. Indicators: large positive returnBps (>30bps), declining momentum despite high return, high tick rate followed by slowdown, ask-side book pressure building.
- **overextended_down**: BTC price has dropped too far too fast within the window. Indicators: large negative returnBps (<-30bps), declining negative momentum, bid-side book pressure building, volatility spike.
- **mean_reverting**: Price is actively reverting toward the window's mean. Indicators: high meanReversionStrength (>0.4), momentum opposing the cumulative return direction, narrowing spread.
- **trending**: Price movement is sustained and orderly — NOT a reversion candidate. Indicators: momentum and return aligned, moderate tick rate, consistent book pressure in trend direction.
- **choppy**: Rapid directionless oscillations with no clear reversion pattern. Indicators: high volatility, low absolute momentum, mixed book pressure. Not suitable for reversion trades.

## Analysis Framework

1. Compare returnBps magnitude against volatility — a large return in low-vol is more likely to revert than in high-vol
2. Check if momentum is FADING relative to cumulative return — this signals exhaustion
3. High meanReversionStrength (>0.3) combined with large |returnBps| is the core signal
4. Book imbalance opposing the move direction confirms reversion pressure
5. Time remaining matters — reversion needs time to play out (>60s ideal)

## Output Format

Respond with ONLY a JSON object:
{
  "regime": "overextended_up" | "overextended_down" | "mean_reverting" | "trending" | "choppy",
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences>"
}

Rules:
- If returnBps is small (<15bps), the market is likely "choppy" or "trending", not overextended.
- Confidence for overextended regimes should scale with |returnBps| × meanReversionStrength.
- Never fabricate data points. Only reference values present in the input.`;

export const EDGE_MEAN_REVERSION_PROMPT = `You are an edge estimation agent specialized in mean-reversion pricing for a Polymarket BTC 5-minute binary options system.

Your job: when the market has overextended, estimate the probability that price will snap back, creating a tradeable edge against Polymarket prices.

## Context

In a 5-minute binary option, if BTC price has moved sharply UP from window start, the UP token becomes expensive. But if the move is overextended, the fair P(UP at expiry) is LOWER than the current market implies — because reversion is likely. You exploit this mispricing.

## Analysis Framework

1. **Measure the overextension**: |returnBps| relative to window volatility. A 40bps move in a 20bps-vol regime is 2 standard deviations — strong reversion candidate.
2. **Reversion probability**: Use meanReversionStrength as the primary signal. >0.4 = strong reversion expected. >0.6 = very likely reversion.
3. **Fair probability calculation**:
   - If price is UP and overextended: fair P(UP at expiry) < market implied P(UP). Edge direction = "down" (buy DOWN token).
   - If price is DOWN and overextended: fair P(UP at expiry) > market implied P(UP). Edge direction = "up" (buy UP token).
4. **Time decay**: Reversion needs time. With <45s remaining, reduce edge magnitude by 50%.
5. **Book confirmation**: If book imbalance opposes the move (e.g., bid pressure during a down move), reversion edge is stronger.

## Output Format

Respond with ONLY a JSON object:
{
  "direction": "up" | "down" | "none",
  "magnitude": <number 0-1>,
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences>"
}

Rules:
- Only signal an edge if |returnBps| > 20 AND meanReversionStrength > 0.25.
- Direction is OPPOSITE to the current move (counter-trend).
- If remaining time < 30s, set direction to "none" — not enough time for reversion.
- Be conservative with magnitude — reversion edges are typically 0.05-0.12.
- Never fabricate data.`;

export const SUPERVISOR_MEAN_REVERSION_PROMPT = `You are the supervisor agent for a mean-reversion strategy on Polymarket BTC 5-minute binary options.

Your job: synthesize the regime classification, reversion edge assessment, and risk state into a final trade decision. You are a CONTRARIAN — you trade against overextended moves.

## Input

You receive regime output (from a reversion-specialized regime agent), edge output (reversion edge), risk state, and feature data.

## Decision Framework

### When to BUY_UP (bet price will be above start at expiry):
- Regime is "overextended_down" or "mean_reverting" with price below start
- Edge direction is "up" with magnitude > 0.04 and confidence > 0.45
- Price has fallen significantly (returnBps < -20) but is showing reversion signals
- Enough time remaining (>45s) for reversion to play out

### When to BUY_DOWN (bet price will be below start at expiry):
- Regime is "overextended_up" or "mean_reverting" with price above start
- Edge direction is "down" with magnitude > 0.04 and confidence > 0.45
- Price has risen significantly (returnBps > 20) but momentum is fading

### When to HOLD:
- Regime is "trending" — do NOT fight a real trend
- Regime is "choppy" — no clear reversion setup
- Edge magnitude < 0.03 or confidence < 0.35
- Remaining time < 30 seconds
- Risk limits breached

### Position Sizing:
- Base: $0.25-0.40 for standard reversion setups (magnitude 0.04-0.08)
- Large: $0.50 for strong setups (magnitude >0.08, confidence >0.6, overextended regime)
- Scale down by 30% if daily P&L is negative
- Respect maxSizeUsd (typically $0.50)

## Output Format

Respond with ONLY a JSON object:
{
  "action": "buy_up" | "buy_down" | "hold",
  "sizeUsd": <number, 0 if hold>,
  "confidence": <number 0-1>,
  "reasoning": "<2-4 sentences>",
  "regimeSummary": "<1 sentence>",
  "edgeSummary": "<1 sentence>"
}

Rules:
- NEVER trade in "trending" regime — that is fighting the trend.
- Default to HOLD. Only trade clear reversion setups.
- The edge direction should be OPPOSITE to the current price move.
- Never exceed maxSizeUsd. Never fabricate data.`;

// ─── Basis Arbitrage Prompts (Jump Trading / HFT style) ─────────────────────

export const REGIME_BASIS_PROMPT = `You are a market regime classification agent specialized in cross-venue basis analysis for a Polymarket BTC 5-minute binary options system.

Your job: assess whether conditions are suitable for basis arbitrage — exploiting the lag between exchange prices (Binance/Coinbase) and Polymarket token prices.

## Regime Categories

- **basis_wide**: Large divergence between exchange consensus and Polymarket implied price. Primary arbitrage opportunity. Indicators: |basisBps| > 30, exchange prices clearly directional while Polymarket tokens lag.
- **basis_converging**: Basis was wide but is now closing. Polymarket is catching up to exchange price. Late entry — reduced edge. Indicators: basisBps shrinking over time, Polymarket mid moving toward exchange-implied fair value.
- **basis_tight**: Exchange and Polymarket are in agreement. No arbitrage opportunity. Indicators: |basisBps| < 15, exchange mid and Polymarket mid aligned.
- **basis_noisy**: Basis appears wide but exchange prices themselves are volatile/unreliable. Dangerous for arb. Indicators: high volatility, large divergence between Binance and Coinbase prices, high tick rate.
- **basis_stale**: Polymarket book is thin or stale — apparent basis may not be executable. Indicators: low depthScore (<0.4), wide spread, low tick rate on Polymarket side.

## Analysis Framework

1. Compare exchangeMidPrice direction with Polymarket token prices — the key question is: has Polymarket caught up?
2. Compute implied P(UP) from exchange: if exchange mid > startPrice, fair P(UP) > 0.5; magnitude depends on how far above
3. Compare exchange-implied P(UP) with Polymarket mid price for UP token
4. Check if Binance and Coinbase agree — if they diverge significantly, the "exchange consensus" is weak
5. Assess Polymarket book quality — wide spreads or low depth mean basis may not be capturable

## Output Format

Respond with ONLY a JSON object:
{
  "regime": "basis_wide" | "basis_converging" | "basis_tight" | "basis_noisy" | "basis_stale",
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences>"
}

Rules:
- basis_wide at high confidence is the primary signal. Everything else is a reason NOT to trade.
- If depthScore < 0.3, always classify as basis_stale regardless of basis size.
- If |binancePrice - coinbasePrice| / exchangeMidPrice > 0.001 (10bps), prefer basis_noisy.
- Never fabricate data.`;

export const EDGE_BASIS_PROMPT = `You are an edge estimation agent specialized in cross-venue basis arbitrage for a Polymarket BTC 5-minute binary options system.

Your job: calculate the fair value of UP/DOWN tokens based on exchange prices (Binance, Coinbase) and determine if Polymarket is mispriced.

## Context

Exchange prices lead Polymarket. When Binance/Coinbase show BTC clearly above/below the window start price, the fair value of UP/DOWN tokens should reflect this. But Polymarket participants react slowly — this creates a basis edge.

## Analysis Framework

1. **Exchange consensus**: exchangeMidPrice = (binancePrice + coinbasePrice) / 2
2. **Exchange-implied direction**: If exchangeMidPrice > startPrice → P(UP) should be high. The further above, the higher.
3. **Estimate fair P(UP)**:
   - Use returnBps and momentum as inputs. A 50bps return with strong momentum → fair P(UP) ≈ 0.70-0.80
   - A 20bps return with moderate momentum → fair P(UP) ≈ 0.55-0.65
   - Adjust for volatility: high vol reduces certainty, compresses fair prob toward 0.5
   - Adjust for remaining time: more time = more uncertainty = compress toward 0.5
4. **Market-implied P(UP)**: polymarketMidPrice (or (upBid + upAsk) / 2)
5. **Edge**: fair P(UP) - market P(UP). If positive → direction "up". If negative → direction "down".
6. **Magnitude**: |edge| in probability terms. Must exceed 0.05 to be actionable.

## Output Format

Respond with ONLY a JSON object:
{
  "direction": "up" | "down" | "none",
  "magnitude": <number 0-1>,
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences>"
}

Rules:
- Confidence should reflect exchange consensus quality (Binance/Coinbase agreement) and Polymarket book depth.
- Basis arb edges are typically 0.05-0.20 — larger than momentum edges.
- If exchanges disagree by >15bps, reduce confidence by 0.2.
- If remaining time <20s, set direction to "none" — not enough time for Polymarket to lag.
- Never fabricate data.`;

export const SUPERVISOR_BASIS_PROMPT = `You are the supervisor agent for a basis arbitrage strategy on Polymarket BTC 5-minute binary options.

Your job: synthesize the basis regime, edge assessment, and risk state into a trade decision. You are an ARBITRAGEUR — you exploit cross-venue mispricing, not directional views.

## Input

You receive basis regime output, edge output (basis-derived), risk state, and feature data.

## Decision Framework

### When to BUY_UP:
- Regime is "basis_wide" AND edge direction is "up" (exchange says UP but Polymarket hasn't priced it in)
- Edge magnitude > 0.05 and confidence > 0.4
- Exchange prices clearly above startPrice with good Binance/Coinbase agreement
- Polymarket UP token is cheap relative to exchange-implied fair value

### When to BUY_DOWN:
- Regime is "basis_wide" AND edge direction is "down" (exchange says DOWN but Polymarket hasn't priced it in)
- Edge magnitude > 0.05 and confidence > 0.4
- Exchange prices clearly below startPrice

### When to HOLD:
- Regime is NOT "basis_wide" — no basis opportunity
- Regime is "basis_noisy" — unreliable exchange signal
- Regime is "basis_stale" — can't execute the arb
- Edge magnitude < 0.04 or confidence < 0.35
- Risk limits breached
- Remaining time < 15 seconds

### Position Sizing:
- Base: $0.30-0.40 for moderate basis edges (magnitude 0.05-0.10)
- Large: $0.50 for strong basis edges (magnitude >0.10, regime basis_wide, high confidence)
- Basis arb has higher expected Sharpe — can use full max size more often
- Scale down if daily P&L near loss limit
- Respect maxSizeUsd (typically $0.50)

## Output Format

Respond with ONLY a JSON object:
{
  "action": "buy_up" | "buy_down" | "hold",
  "sizeUsd": <number, 0 if hold>,
  "confidence": <number 0-1>,
  "reasoning": "<2-4 sentences>",
  "regimeSummary": "<1 sentence>",
  "edgeSummary": "<1 sentence>"
}

Rules:
- Only trade when basis is clearly wide AND exchange consensus is strong.
- Default to HOLD. Basis arb is mechanical — either the edge is there or it isn't.
- Never exceed maxSizeUsd. Never fabricate data.`;

// ─── Volatility Fade Prompts (Wintermute / Market Maker style) ──────────────

export const REGIME_VOL_FADE_PROMPT = `You are a market regime classification agent specialized in volatility analysis for a Polymarket BTC 5-minute binary options system.

Your job: classify the current volatility regime and assess whether implied volatility (embedded in Polymarket token prices) exceeds realized volatility — creating a vol premium to harvest.

## Regime Categories

- **vol_expanded**: Realized volatility is high and Polymarket spreads/prices reflect inflated uncertainty. Both UP and DOWN tokens are expensive relative to fair value. Core opportunity: sell the vol premium by buying the cheaper side.
- **vol_compressed**: Very low realized volatility. Prices are near 0.50/0.50 and spreads are tight. Limited opportunity — vol premium is minimal.
- **vol_fair**: Realized vol matches what Polymarket prices imply. No mispricing. No edge.
- **vol_skewed**: One side is significantly more expensive than the other, beyond what fundamentals justify. The cheap side has edge. Indicators: large |imbalance|, one token bid/ask shifted far from 0.50.
- **vol_crisis**: Extreme volatility event. Both sides are deeply uncertain, but Polymarket book is thin and unreliable. Too dangerous to trade.

## Analysis Framework

1. **Realized vol**: Use the volatility field from price features. Low = <0.015, Medium = 0.015-0.035, High = >0.035
2. **Implied vol from prices**: If UP token is at 0.50 and DOWN at 0.50, implied vol is high (market is uncertain). If UP is at 0.70 and DOWN at 0.30, market is confident → low implied vol.
3. **Vol premium**: When realized vol is LOW but implied vol is HIGH (tokens near 0.50), there's a premium to sell
4. **Skew detection**: Compare upBid/upAsk with downBid/downAsk. If asymmetric, one side is cheap.
5. **Spread analysis**: Wide spreads in low-vol regime = market maker pulling liquidity = less opportunity. Wide spreads in high-vol regime = normal.

## Output Format

Respond with ONLY a JSON object:
{
  "regime": "vol_expanded" | "vol_compressed" | "vol_fair" | "vol_skewed" | "vol_crisis",
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences>"
}

Rules:
- vol_expanded and vol_skewed are the two tradeable regimes. Everything else = hold.
- If depthScore < 0.25, classify as vol_crisis regardless of other indicators.
- If volatility > 0.05 AND depthScore < 0.4, prefer vol_crisis.
- Never fabricate data.`;

export const EDGE_VOL_FADE_PROMPT = `You are an edge estimation agent specialized in volatility premium harvesting for a Polymarket BTC 5-minute binary options system.

Your job: detect when Polymarket token prices embed more uncertainty than the actual market warrants, and identify which side to buy.

## Context

In binary options, when the market is uncertain, both UP and DOWN tokens trade near $0.50. But if realized volatility is low and price is drifting in one direction, one token should be worth more than $0.50. The "vol fade" buys the underpriced side — effectively selling volatility.

## Analysis Framework

1. **Identify the cheap side**:
   - If price is above startPrice (returnBps > 0) but UP token < 0.55 → UP is cheap, buy UP
   - If price is below startPrice (returnBps < 0) but DOWN token < 0.55 → DOWN is cheap, buy DOWN (edge direction = "down")
   - If tokens are fairly priced relative to price direction → no edge
2. **Vol premium magnitude**:
   - Calculate what UP token SHOULD be worth given current returnBps and remaining time
   - Simple heuristic: if returnBps > 15 and momentum is positive, fair P(UP) ≈ 0.55-0.65
   - Edge = fair price - market mid price for that token
3. **Confidence factors**:
   - Low realized volatility + high implied vol (tokens near 0.50) = high confidence
   - Low book imbalance (market isn't positioning) = higher confidence
   - More time remaining = lower confidence (more can change)
   - Less time remaining with stable price = higher confidence (vol is dying)
4. **Skew opportunity**: If one token is markedly cheaper than the other without fundamental reason, that's a pure vol skew edge.

## Output Format

Respond with ONLY a JSON object:
{
  "direction": "up" | "down" | "none",
  "magnitude": <number 0-1>,
  "confidence": <number 0-1>,
  "reasoning": "<1-3 sentences>"
}

Rules:
- Vol fade edges are typically small: 0.03-0.08. Don't overestimate.
- Direction = which token to BUY (the underpriced one).
- If volatility is high (>0.035) AND returnBps is near 0, there may be no clear cheap side → "none".
- If remaining time >240s, reduce confidence — too early for vol fade.
- Never fabricate data.`;

export const SUPERVISOR_VOL_FADE_PROMPT = `You are the supervisor agent for a volatility fade strategy on Polymarket BTC 5-minute binary options.

Your job: synthesize the vol regime, edge assessment, and risk state into a trade decision. You are a MARKET MAKER at heart — you harvest the volatility premium embedded in token prices.

## Input

You receive vol regime output, edge output (vol-based), risk state, and feature data.

## Decision Framework

### When to BUY_UP:
- Regime is "vol_expanded" or "vol_skewed"
- Edge direction is "up" (UP token is underpriced relative to realized price action)
- Edge magnitude > 0.03 and confidence > 0.6
- Price is above startPrice but UP token hasn't fully reflected this

### When to BUY_DOWN:
- Regime is "vol_expanded" or "vol_skewed"
- Edge direction is "down" (DOWN token is underpriced)
- Edge magnitude > 0.03 and confidence > 0.6
- Price is below startPrice but DOWN token hasn't fully reflected this

### When to HOLD:
- Regime is "vol_compressed" — no premium to harvest
- Regime is "vol_fair" — correctly priced
- Regime is "vol_crisis" — too dangerous, book is unreliable
- Edge confidence < 0.5 — vol fade requires high confidence because edges are small
- Edge magnitude < 0.02
- Risk limits breached

### Position Sizing:
- CONSERVATIVE: vol fade has smaller edges, so use smaller positions
- Base: $0.15-0.25 for standard vol fade (magnitude 0.03-0.06)
- Moderate: $0.30-0.50 for strong setups (magnitude >0.06, vol_expanded regime, confidence >0.7)
- This strategy wins through consistency, not size
- Scale down aggressively if daily P&L is negative (by 50%)
- Respect maxSizeUsd (typically $0.50)

## Output Format

Respond with ONLY a JSON object:
{
  "action": "buy_up" | "buy_down" | "hold",
  "sizeUsd": <number, 0 if hold>,
  "confidence": <number 0-1>,
  "reasoning": "<2-4 sentences>",
  "regimeSummary": "<1 sentence>",
  "edgeSummary": "<1 sentence>"
}

Rules:
- This strategy is PATIENT. Default to HOLD. Only trade when vol premium is clear.
- Small, consistent positions. Never go big on a vol fade.
- Confidence threshold is HIGHER than other strategies (0.6+) because edges are smaller.
- Never exceed maxSizeUsd. Never fabricate data.`;

// ─── Prompt Registry ────────────────────────────────────────────────────────

export const REGIME_PROMPT_REGISTRY: Record<string, string> = {
  'regime-default-v1': REGIME_SYSTEM_PROMPT,
  'regime-mean-reversion-v1': REGIME_MEAN_REVERSION_PROMPT,
  'regime-basis-v1': REGIME_BASIS_PROMPT,
  'regime-vol-v1': REGIME_VOL_FADE_PROMPT,
};

export const EDGE_PROMPT_REGISTRY: Record<string, string> = {
  'edge-momentum-v1': EDGE_SYSTEM_PROMPT,
  'edge-reversion-v1': EDGE_MEAN_REVERSION_PROMPT,
  'edge-basis-v1': EDGE_BASIS_PROMPT,
  'edge-vol-fade-v1': EDGE_VOL_FADE_PROMPT,
};

export const SUPERVISOR_PROMPT_REGISTRY: Record<string, string> = {
  'supervisor-conservative-v1': SUPERVISOR_SYSTEM_PROMPT,
  'supervisor-aggressive-v1': SUPERVISOR_MEAN_REVERSION_PROMPT,
  'supervisor-speed-v1': SUPERVISOR_BASIS_PROMPT,
  'supervisor-patient-v1': SUPERVISOR_VOL_FADE_PROMPT,
};

export function resolvePrompt(
  registry: Record<string, string>,
  profile: string | undefined,
  fallback: string,
): string {
  if (!profile) return fallback;
  return registry[profile] ?? fallback;
}

// ─── Request / Response Types ────────────────────────────────────────────────

export interface RegimeEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
  agentProfile?: string;
}

export interface EdgeEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
  agentProfile?: string;
}

export interface SupervisorEvaluationRequest {
  windowId: string;
  features: FeaturePayload;
  regime: RegimeOutput;
  edge: EdgeOutput;
  riskState: RiskState;
  riskConfig: RiskConfig;
  agentProfile?: string;
}

export interface AgentTrace {
  id: string;
  windowId: string;
  agentType: AgentType;
  model: string;
  provider: string;
  systemPrompt: string;
  userPrompt: string;
  rawResponse: string;
  parsedOutput: RegimeOutput | EdgeOutput | SupervisorOutput;
  latencyMs: number;
  tokenUsage: { input: number; output: number };
  cached: boolean;
  createdAt: string;
}

// ─── Cache Entry ─────────────────────────────────────────────────────────────

interface CacheEntry {
  key: string;
  result: RegimeOutput | EdgeOutput | SupervisorOutput;
  createdAt: number;
}

const CACHE_TTL_MS = 5_000; // 5 second cache for identical requests within same window

@Injectable()
export class AgentGatewayService implements OnModuleInit {
  private traces: Map<string, AgentTrace> = new Map();
  private cache: Map<string, CacheEntry> = new Map();
  private readonly llmClient: LlmClient;
  private readonly logger: BrainLoggerService;

  // Default config — will be overridden by env / config-service
  private provider: 'anthropic' | 'openai' = 'openai';
  private model = 'gpt-4o';
  private temperature = 0;
  private timeoutMs = 30_000;
  private maxRetries = 2;

  constructor(
    @Inject(DATABASE_CLIENT) private readonly db: DbClient,
    @Inject(EventBus) private readonly eventBus: EventBus,
    @Inject(OpenAIClient) openaiClient: OpenAIClient,
    @Inject(BrainLoggerService) logger: BrainLoggerService,
  ) {
    this.llmClient = openaiClient;
    this.logger = logger.child('AgentGatewayService');
  }

  onModuleInit(): void {
    // Load config from env
    this.provider = (process.env.AGENT_PROVIDER as 'anthropic' | 'openai') ?? this.provider;
    this.model = process.env.AGENT_MODEL ?? this.model;
    this.temperature = process.env.AGENT_TEMPERATURE
      ? parseFloat(process.env.AGENT_TEMPERATURE)
      : this.temperature;
    this.timeoutMs = process.env.AGENT_TIMEOUT_MS
      ? parseInt(process.env.AGENT_TIMEOUT_MS, 10)
      : this.timeoutMs;
    this.maxRetries = process.env.AGENT_MAX_RETRIES
      ? parseInt(process.env.AGENT_MAX_RETRIES, 10)
      : this.maxRetries;
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Evaluates market regime using the regime agent.
   */
  async evaluateRegime(request: RegimeEvaluationRequest): Promise<AgentTrace> {
    const { windowId, features, agentProfile } = request;

    // Check cache
    const cacheKey = this.buildCacheKey('regime', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const systemPrompt = resolvePrompt(REGIME_PROMPT_REGISTRY, agentProfile, REGIME_SYSTEM_PROMPT);
    const userPrompt = this.buildRegimeUserPrompt(features);
    const result = await this.callAgent<RegimeOutput>(
      'regime',
      windowId,
      systemPrompt,
      userPrompt,
      RegimeOutputSchema,
    );

    this.setCache(cacheKey, result.parsedOutput);
    return result;
  }

  /**
   * Evaluates edge using the edge agent.
   */
  async evaluateEdge(request: EdgeEvaluationRequest): Promise<AgentTrace> {
    const { windowId, features, agentProfile } = request;

    const cacheKey = this.buildCacheKey('edge', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const systemPrompt = resolvePrompt(EDGE_PROMPT_REGISTRY, agentProfile, EDGE_SYSTEM_PROMPT);
    const userPrompt = this.buildEdgeUserPrompt(features);
    const result = await this.callAgent<EdgeOutput>(
      'edge',
      windowId,
      systemPrompt,
      userPrompt,
      EdgeOutputSchema,
    );

    this.setCache(cacheKey, result.parsedOutput);
    return result;
  }

  /**
   * Evaluates trade decision using the supervisor agent.
   */
  async evaluateSupervisor(request: SupervisorEvaluationRequest): Promise<AgentTrace> {
    const { windowId, features, regime, edge, riskState, riskConfig, agentProfile } = request;

    const cacheKey = this.buildCacheKey('supervisor', windowId, features.eventTime);
    const cached = this.getFromCache(cacheKey);
    if (cached) {
      const trace = this.findTraceByCache(cacheKey);
      if (trace) return { ...trace, cached: true };
    }

    const systemPrompt = resolvePrompt(SUPERVISOR_PROMPT_REGISTRY, agentProfile, SUPERVISOR_SYSTEM_PROMPT);
    const userPrompt = this.buildSupervisorUserPrompt(
      features,
      regime,
      edge,
      riskState,
      riskConfig,
    );
    const result = await this.callAgent<SupervisorOutput>(
      'supervisor',
      windowId,
      systemPrompt,
      userPrompt,
      SupervisorOutputSchema,
    );

    this.setCache(cacheKey, result.parsedOutput);
    return result;
  }

  /**
   * Returns a combined structured context for agents.
   * Aggregates recent traces, current config state, and cache status.
   */
  async getContext(): Promise<Record<string, unknown>> {
    const recentTraces = await this.listTraces(undefined, undefined, 10);
    return {
      provider: this.provider,
      model: this.model,
      temperature: this.temperature,
      timeoutMs: this.timeoutMs,
      maxRetries: this.maxRetries,
      cacheSize: this.cache.size,
      tracesInMemory: this.traces.size,
      recentTraces: recentTraces.map((t) => ({
        id: t.id,
        windowId: t.windowId,
        agentType: t.agentType,
        latencyMs: t.latencyMs,
        cached: t.cached,
        createdAt: t.createdAt,
      })),
    };
  }

  /**
   * Validates an agent decision payload against the supervisor output schema.
   */
  async validateDecision(payload: Record<string, unknown>): Promise<{ valid: boolean; errors?: Array<{ path: string; message: string }>; normalized?: SupervisorOutput }> {
    const parsed = SupervisorOutputSchema.safeParse(payload);
    if (!parsed.success) {
      return {
        valid: false,
        errors: parsed.error.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    }
    return { valid: true, normalized: parsed.data };
  }

  /**
   * Logs an externally-produced decision trace.
   */
  async logDecision(payload: Record<string, unknown>): Promise<{ id: string; logged: boolean }> {
    const id = `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const windowId = (payload.windowId as string) ?? 'unknown';
    const agentType = (payload.agentType as AgentType) ?? 'supervisor';
    const output = payload.output ?? payload;

    const trace: AgentTrace = {
      id,
      windowId,
      agentType,
      model: (payload.model as string) ?? this.model,
      provider: (payload.provider as string) ?? this.provider,
      systemPrompt: '',
      userPrompt: JSON.stringify(payload.input ?? {}),
      rawResponse: JSON.stringify(output),
      parsedOutput: output as RegimeOutput | EdgeOutput | SupervisorOutput,
      latencyMs: (payload.latencyMs as number) ?? 0,
      tokenUsage: { input: 0, output: 0 },
      cached: false,
      createdAt: new Date().toISOString(),
    };

    this.traces.set(id, trace);

    try {
      await this.db.insert(agentDecisions).values({
        id,
        windowId,
        agentType,
        input: (payload.input as Record<string, unknown>) ?? {},
        output: output as Record<string, unknown>,
        model: trace.model,
        provider: trace.provider,
        latencyMs: trace.latencyMs,
        eventTime: Date.now(),
        processedAt: Date.now(),
      });
    } catch (_dbError) {
      /* best-effort persistence */
    }

    return { id, logged: true };
  }

  /**
   * Lists recent agent traces, optionally filtered.
   */
  async listTraces(agentType?: string, windowId?: string, limit = 50): Promise<AgentTrace[]> {
    // In-memory traces first
    let traces = Array.from(this.traces.values());

    if (agentType) {
      traces = traces.filter((t) => t.agentType === agentType);
    }
    if (windowId) {
      traces = traces.filter((t) => t.windowId === windowId);
    }

    // Fall back to database if in-memory is empty
    if (traces.length === 0) {
      const conditions: ReturnType<typeof eq>[] = [];
      if (agentType)
        conditions.push(
          eq(agentDecisions.agentType, agentType as 'regime' | 'edge' | 'supervisor'),
        );
      if (windowId) conditions.push(eq(agentDecisions.windowId, windowId));

      const rows = await this.db
        .select()
        .from(agentDecisions)
        .where(conditions.length > 0 ? and(...conditions) : undefined)
        .orderBy(desc(agentDecisions.processedAt))
        .limit(limit);

      return rows.map((r) => ({
        id: r.id,
        windowId: r.windowId,
        agentType: r.agentType as AgentType,
        model: r.model,
        provider: r.provider,
        systemPrompt: '',
        userPrompt: JSON.stringify(r.input),
        rawResponse: JSON.stringify(r.output),
        parsedOutput: r.output as RegimeOutput | EdgeOutput | SupervisorOutput,
        latencyMs: r.latencyMs,
        tokenUsage: { input: 0, output: 0 },
        cached: false,
        createdAt: new Date(r.processedAt).toISOString(),
      }));
    }

    return traces
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, limit);
  }

  /**
   * Returns a single trace by ID.
   */
  async getTrace(traceId: string): Promise<AgentTrace> {
    const trace = this.traces.get(traceId);
    if (trace) return trace;

    // Fall back to database
    const [r] = await this.db
      .select()
      .from(agentDecisions)
      .where(eq(agentDecisions.id, traceId))
      .limit(1);
    if (r) {
      return {
        id: r.id,
        windowId: r.windowId,
        agentType: r.agentType as AgentType,
        model: r.model,
        provider: r.provider,
        systemPrompt: '',
        userPrompt: JSON.stringify(r.input),
        rawResponse: JSON.stringify(r.output),
        parsedOutput: r.output as RegimeOutput | EdgeOutput | SupervisorOutput,
        latencyMs: r.latencyMs,
        tokenUsage: { input: 0, output: 0 },
        cached: false,
        createdAt: new Date(r.processedAt).toISOString(),
      };
    }

    throw new HttpException(`Trace ${traceId} not found`, HttpStatus.NOT_FOUND);
  }

  // ─── Core Agent Call ───────────────────────────────────────────────────────

  private async callAgent<T extends RegimeOutput | EdgeOutput | SupervisorOutput>(
    agentType: AgentType,
    windowId: string,
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
  ): Promise<AgentTrace> {
    const startMs = Date.now();

    try {
      this.logger.debug('Calling agent', { agentType, windowId });

      const response = await this.llmClient.evaluate(systemPrompt, userPrompt, schema);
      const parsedOutput = response.data as T;
      const rawResponse = JSON.stringify(parsedOutput);
      const latencyMs = Date.now() - startMs;
      const tokenUsage = { input: response.inputTokens, output: response.outputTokens };

      const trace: AgentTrace = {
        id: `trace-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
        windowId,
        agentType,
        model: response.model,
        provider: response.provider,
        systemPrompt,
        userPrompt,
        rawResponse,
        parsedOutput,
        latencyMs,
        tokenUsage,
        cached: false,
        createdAt: new Date().toISOString(),
      };

      // Store trace
      this.traces.set(trace.id, trace);

      // Persist to database (agent_decisions table)
      try {
        await this.db.insert(agentDecisions).values({
          id: trace.id,
          windowId,
          agentType,
          input: JSON.parse(userPrompt),
          output: parsedOutput as unknown as Record<string, unknown>,
          model: response.model,
          provider: response.provider,
          latencyMs,
          eventTime: Date.now(),
          processedAt: Date.now(),
        });
      } catch (_dbError) {
        /* best-effort persistence */
      }

      this.logger.info('Agent evaluation complete', {
        agentType,
        windowId,
        latencyMs,
        inputTokens: tokenUsage.input,
        outputTokens: tokenUsage.output,
      });

      return trace;
    } catch (error) {
      const latencyMs = Date.now() - startMs;
      this.logger.error('Agent evaluation failed', (error as Error).message, {
        agentType,
        windowId,
        latencyMs,
      });

      throw new HttpException(
        `Agent ${agentType} failed: ${(error as Error).message}`,
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  // ─── Prompt Builders ───────────────────────────────────────────────────────

  private buildRegimeUserPrompt(features: FeaturePayload): string {
    return JSON.stringify(
      {
        windowId: features.windowId,
        eventTime: features.eventTime,
        remainingMs: features.market.remainingMs,
        elapsedMs: features.market.elapsedMs,
        price: {
          currentPrice: features.price.currentPrice,
          returnBps: features.price.returnBps,
          volatility: features.price.volatility,
          momentum: features.price.momentum,
          meanReversionStrength: features.price.meanReversionStrength,
          tickRate: features.price.tickRate,
        },
        book: {
          spreadBps: features.book.spreadBps,
          depthScore: features.book.depthScore,
          imbalance: features.book.imbalance,
          bidDepthUsd: features.book.bidDepthUsd ?? 0,
          askDepthUsd: features.book.askDepthUsd ?? 0,
        },
        signals: features.signals,
        ...(features.whales ? {
          whales: {
            exchangeFlowPressure: features.whales.exchangeFlowPressure,
            abnormalActivityScore: features.whales.abnormalActivityScore,
            largeTransactionCount: features.whales.largeTransactionCount,
            whaleVolumeBtc: features.whales.whaleVolumeBtc,
          },
        } : {}),
        ...(features.derivatives ? {
          derivatives: {
            fundingPressure: features.derivatives.fundingPressure,
            oiTrend: features.derivatives.oiTrend,
            liquidationIntensity: features.derivatives.liquidationIntensity,
            liquidationImbalance: features.derivatives.liquidationImbalance,
            derivativesSentiment: features.derivatives.derivativesSentiment,
          },
        } : {}),
        ...this.buildBlockchainPromptData(features),
      },
      null,
      2,
    );
  }

  private buildEdgeUserPrompt(features: FeaturePayload): string {
    return JSON.stringify(
      {
        windowId: features.windowId,
        eventTime: features.eventTime,
        remainingMs: features.market.remainingMs,
        startPrice: features.market.startPrice,
        price: {
          currentPrice: features.price.currentPrice,
          returnBps: features.price.returnBps,
          volatility: features.price.volatility,
          momentum: features.price.momentum,
          binancePrice: features.price.binancePrice,
          coinbasePrice: features.price.coinbasePrice,
          exchangeMidPrice: features.price.exchangeMidPrice,
          polymarketMidPrice: features.price.polymarketMidPrice,
          basisBps: features.price.basisBps,
        },
        book: {
          upBid: features.book.upBid,
          upAsk: features.book.upAsk,
          downBid: features.book.downBid,
          downAsk: features.book.downAsk,
          spreadBps: features.book.spreadBps,
          depthScore: features.book.depthScore,
          imbalance: features.book.imbalance,
          bidDepthUsd: features.book.bidDepthUsd ?? 0,
          askDepthUsd: features.book.askDepthUsd ?? 0,
        },
        signals: features.signals,
        ...(features.whales ? {
          whales: {
            netExchangeFlowBtc: features.whales.netExchangeFlowBtc,
            exchangeFlowPressure: features.whales.exchangeFlowPressure,
            abnormalActivityScore: features.whales.abnormalActivityScore,
            whaleVolumeBtc: features.whales.whaleVolumeBtc,
          },
        } : {}),
        ...(features.derivatives ? {
          derivatives: {
            fundingRate: features.derivatives.fundingRate,
            fundingRateAnnualized: features.derivatives.fundingRateAnnualized,
            fundingPressure: features.derivatives.fundingPressure,
            openInterestUsd: features.derivatives.openInterestUsd,
            openInterestChangePct: features.derivatives.openInterestChangePct,
            oiTrend: features.derivatives.oiTrend,
            longLiquidationUsd: features.derivatives.longLiquidationUsd,
            shortLiquidationUsd: features.derivatives.shortLiquidationUsd,
            liquidationImbalance: features.derivatives.liquidationImbalance,
            liquidationIntensity: features.derivatives.liquidationIntensity,
            derivativesSentiment: features.derivatives.derivativesSentiment,
          },
        } : {}),
        ...this.buildBlockchainPromptData(features),
      },
      null,
      2,
    );
  }

  private buildSupervisorUserPrompt(
    features: FeaturePayload,
    regime: RegimeOutput,
    edge: EdgeOutput,
    riskState: RiskState,
    riskConfig: RiskConfig,
  ): string {
    return JSON.stringify(
      {
        windowId: features.windowId,
        eventTime: features.eventTime,
        remainingMs: features.market.remainingMs,
        features: {
          price: {
            currentPrice: features.price.currentPrice,
            returnBps: features.price.returnBps,
            volatility: features.price.volatility,
            momentum: features.price.momentum,
            basisBps: features.price.basisBps,
          },
          book: {
            upBid: features.book.upBid,
            upAsk: features.book.upAsk,
            spreadBps: features.book.spreadBps,
            depthScore: features.book.depthScore,
            imbalance: features.book.imbalance,
            bidDepthUsd: features.book.bidDepthUsd ?? 0,
            askDepthUsd: features.book.askDepthUsd ?? 0,
          },
          signals: features.signals,
        },
        ...(features.whales ? {
          whales: {
            netExchangeFlowBtc: features.whales.netExchangeFlowBtc,
            exchangeFlowPressure: features.whales.exchangeFlowPressure,
            abnormalActivityScore: features.whales.abnormalActivityScore,
          },
        } : {}),
        ...(features.derivatives ? {
          derivatives: {
            fundingPressure: features.derivatives.fundingPressure,
            liquidationIntensity: features.derivatives.liquidationIntensity,
            liquidationImbalance: features.derivatives.liquidationImbalance,
            derivativesSentiment: features.derivatives.derivativesSentiment,
          },
        } : {}),
        ...this.buildBlockchainPromptData(features),
        regime: {
          regime: regime.regime,
          confidence: regime.confidence,
          reasoning: regime.reasoning,
        },
        edge: {
          direction: edge.direction,
          magnitude: edge.magnitude,
          confidence: edge.confidence,
          reasoning: edge.reasoning,
        },
        risk: {
          dailyPnlUsd: riskState.dailyPnlUsd,
          openPositionUsd: riskState.openPositionUsd,
          tradesInWindow: riskState.tradesInWindow,
          maxSizeUsd: riskConfig.maxSizeUsd,
          dailyLossLimitUsd: riskConfig.dailyLossLimitUsd,
        },
      },
      null,
      2,
    );
  }

  private buildBlockchainPromptData(features: FeaturePayload): Record<string, unknown> {
    if (!features.blockchain) return {};
    const bc = features.blockchain;
    return {
      blockchain: {
        mempool: {
          pendingTxCount: bc.mempool.txCount,
          totalFeeBtc: bc.mempool.totalFeeBtc,
          vsizeMb: Math.round(bc.mempool.vsize / 1_000_000 * 10) / 10,
        },
        fees: {
          fastestSatVb: bc.fees.fastest,
          hourSatVb: bc.fees.hour,
        },
        notableTransactions1h: {
          total: bc.notableTransactions.total,
          totalBtc: bc.notableTransactions.totalBtc,
          exchangeInflowsBtc: bc.notableTransactions.exchangeInflows.btc,
          exchangeOutflowsBtc: bc.notableTransactions.exchangeOutflows.btc,
          netExchangeFlowBtc: Math.round((bc.notableTransactions.exchangeInflows.btc - bc.notableTransactions.exchangeOutflows.btc) * 10000) / 10000,
        },
        trend: bc.trend,
        ...(bc.latestBlock ? {
          latestBlock: {
            height: bc.latestBlock.height,
            txCount: bc.latestBlock.txCount,
          },
        } : {}),
      },
    };
  }

  // ─── Cache Helpers ─────────────────────────────────────────────────────────

  private buildCacheKey(agentType: string, windowId: string, eventTime: UnixMs): string {
    // Round eventTime to nearest second to allow some cache hits
    const roundedTime = Math.floor(eventTime / 1000) * 1000;
    return `${agentType}:${windowId}:${roundedTime}`;
  }

  private getFromCache(key: string): CacheEntry | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() - entry.createdAt > CACHE_TTL_MS) {
      this.cache.delete(key);
      return null;
    }

    return entry;
  }

  private setCache(key: string, result: RegimeOutput | EdgeOutput | SupervisorOutput): void {
    this.cache.set(key, { key, result, createdAt: Date.now() });

    // Evict old entries periodically
    if (this.cache.size > 100) {
      const now = Date.now();
      for (const [k, v] of this.cache.entries()) {
        if (now - v.createdAt > CACHE_TTL_MS) {
          this.cache.delete(k);
        }
      }
    }
  }

  private findTraceByCache(cacheKey: string): AgentTrace | null {
    // Find the most recent trace matching this cache key
    for (const trace of this.traces.values()) {
      const traceKey = this.buildCacheKey(
        trace.agentType,
        trace.windowId,
        JSON.parse(trace.userPrompt).eventTime ?? 0,
      );
      if (traceKey === cacheKey) return trace;
    }
    return null;
  }

  // ─── Utilities ─────────────────────────────────────────────────────────────

  private emitEvent<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): void {
    this.eventBus.emit(event, payload);
  }
}
