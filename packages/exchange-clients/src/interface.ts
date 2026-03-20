import type { PriceSource, UnixMs } from '@brain/types';

export interface PriceFeedTick {
  source: PriceSource;
  price: number;
  bid: number;
  ask: number;
  eventTime: UnixMs;
}

export type PriceTickHandler = (tick: PriceFeedTick) => void;

export interface PriceFeedClient {
  readonly source: PriceSource;
  connect(): Promise<void>;
  disconnect(): void;
  onTick(handler: PriceTickHandler): () => void;
  readonly isConnected: boolean;
}
