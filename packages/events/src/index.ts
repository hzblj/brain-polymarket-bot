import { EventEmitter } from 'node:events';
import { Global, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';

// ─── Event Map ──────────────────────────────────────────────────────────────

export interface BrainEventMap {
  // Market discovery events
  'market.active.changed': { previousMarketId: string; newMarketId: string };
  'market.window.opened': { marketId: string; start: string; end: string };
  'market.window.closing': { marketId: string; secondsToClose: number };

  // Price feed events
  'price.tick.received': { resolver: { price: number }; external: { price: number } };

  // Orderbook events
  'book.snapshot.updated': { timestamp: string };
  'book.spread.changed': { spreadBps: number };
  'book.depth.changed': { upBidDepth: number; upAskDepth: number };
  'book.imbalance.changed': { imbalance: number };

  // Whale tracker events
  'whales.large-tx.detected': { txid: string; amountBtc: number; direction: string };
  'whales.flow.updated': { netExchangeFlowBtc: number; exchangeFlowPressure: number; abnormalActivityScore: number };

  // Derivatives feed events
  'derivatives.funding.updated': { fundingRate: number; fundingPressure: number };
  'derivatives.oi.changed': { openInterestUsd: number; changePct: number };
  'derivatives.liquidation.detected': { side: string; quantityUsd: number; price: number };
  'derivatives.cascade.alert': { liquidationIntensity: number; side: string; totalUsd: number };

  // Feature engine events
  'features.computed': { marketId: string; tradeable: boolean; timeToCloseSec: number };

  // Agent gateway events
  'agent.decision.made': { windowId: string; action: string; sizeUsd: number; confidence: number };

  // Risk events
  'risk.approved': { windowId: string; agentDecisionId: string; approved: boolean; approvedSizeUsd: number; rejectionReasons: string[] };
  'risk.rejected': { windowId: string; agentDecisionId: string; approved: boolean; approvedSizeUsd: number; rejectionReasons: string[] };
  'risk.kill-switch.changed': { active: boolean; previous: boolean };
  'risk.config.updated': { config: Record<string, unknown>; tradingEnabled: boolean };

  // Execution events
  'order.created': { orderId: string; mode: string; side: string };
  'order.filled': { orderId: string; mode: string; fillPrice: number; fillSizeUsd: number };
  'order.cancelled': { orderId: string; mode: string };

  // Analysis events
  'trade.analysis.completed': { analysisId: string; windowId: string; orderId: string; profitable: boolean; pnlUsd: number };
  'strategy.report.generated': { reportId: string; periodStart: string; periodEnd: string; totalPnlUsd: number; tradeCount: number };
}

export type BrainEventName = keyof BrainEventMap;

// ─── Typed Event Bus ────────────────────────────────────────────────────────

@Injectable()
export class EventBus implements OnModuleDestroy {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(50);
  }

  emit<E extends BrainEventName>(event: E, payload: BrainEventMap[E]): boolean {
    return this.emitter.emit(event, payload);
  }

  on<E extends BrainEventName>(event: E, listener: (payload: BrainEventMap[E]) => void): this {
    this.emitter.on(event, listener as (...args: unknown[]) => void);
    return this;
  }

  once<E extends BrainEventName>(event: E, listener: (payload: BrainEventMap[E]) => void): this {
    this.emitter.once(event, listener as (...args: unknown[]) => void);
    return this;
  }

  off<E extends BrainEventName>(event: E, listener: (payload: BrainEventMap[E]) => void): this {
    this.emitter.off(event, listener as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners(event?: BrainEventName): this {
    if (event) {
      this.emitter.removeAllListeners(event);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  listenerCount(event: BrainEventName): number {
    return this.emitter.listenerCount(event);
  }

  waitFor<E extends BrainEventName>(event: E, timeoutMs?: number): Promise<BrainEventMap[E]> {
    return new Promise((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;

      const handler = (payload: BrainEventMap[E]) => {
        if (timer) clearTimeout(timer);
        resolve(payload);
      };

      this.once(event, handler);

      if (timeoutMs) {
        timer = setTimeout(() => {
          this.off(event, handler);
          reject(new Error(`Timeout waiting for event: ${event} (${timeoutMs}ms)`));
        }, timeoutMs);
      }
    });
  }

  onModuleDestroy(): void {
    this.emitter.removeAllListeners();
  }
}

// ─── NestJS Module ──────────────────────────────────────────────────────────

@Global()
@Module({
  providers: [EventBus],
  exports: [EventBus],
})
export class EventBusModule {}
