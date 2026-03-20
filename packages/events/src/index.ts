import { Global, Injectable, Module, OnModuleDestroy } from '@nestjs/common';
import { EventEmitter } from 'events';
import type {
  Market,
  MarketWindow,
  BookSnapshot,
  BookMetrics,
  PriceTick,
  FeaturePayload,
  AgentDecision,
  RiskEvaluation,
  Order,
  Fill,
} from '@brain/types';

// ─── Event Map ──────────────────────────────────────────────────────────────

export interface BrainEventMap {
  'market.active.changed': { market: Market; previousStatus: string };
  'market.window.opened': { window: MarketWindow };
  'market.window.closing': { window: MarketWindow; remainingMs: number };
  'book.snapshot.updated': { snapshot: BookSnapshot };
  'book.spread.changed': { windowId: string; spreadBps: number; previousSpreadBps: number };
  'book.depth.changed': { windowId: string; depthScore: number; previousDepthScore: number };
  'book.imbalance.changed': { windowId: string; imbalance: number; previousImbalance: number };
  'price.tick.received': { tick: PriceTick };
  'features.computed': { payload: FeaturePayload };
  'agent.decision.made': { decision: AgentDecision };
  'risk.evaluated': { evaluation: RiskEvaluation };
  'order.created': { order: Order };
  'order.filled': { order: Order; fill: Fill };
  'order.cancelled': { order: Order; reason: string };
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
