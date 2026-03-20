export interface PolymarketMarket {
  condition_id: string;
  question_id: string;
  tokens: PolymarketToken[];
  minimum_order_size: string;
  minimum_tick_size: string;
  description: string;
  category: string;
  end_date_iso: string;
  game_start_time: string;
  question: string;
  market_slug: string;
  active: boolean;
  closed: boolean;
  accepting_orders: boolean;
}

export interface PolymarketToken {
  token_id: string;
  outcome: string;
  price: string;
  winner: boolean;
}

export interface PolymarketOrderbookEntry {
  price: string;
  size: string;
}

export interface PolymarketOrderbook {
  market: string;
  asset_id: string;
  bids: PolymarketOrderbookEntry[];
  asks: PolymarketOrderbookEntry[];
  hash: string;
  timestamp: string;
}

export interface PolymarketOrderRequest {
  tokenID: string;
  price: number;
  size: number;
  side: 'BUY' | 'SELL';
  feeRateBps?: number;
  nonce?: number;
  expiration?: number;
}

export interface PolymarketOrderResponse {
  id: string;
  status: string;
  market: string;
  asset_id: string;
  side: string;
  original_size: string;
  size_matched: string;
  price: string;
  associate_trades: string[];
  created_at: number;
}

export interface PolymarketTradeResponse {
  id: string;
  taker_order_id: string;
  market: string;
  asset_id: string;
  side: string;
  size: string;
  price: string;
  status: string;
  match_time: string;
}

export interface BookUpdateMessage {
  event_type: 'book';
  asset_id: string;
  market: string;
  bids: PolymarketOrderbookEntry[];
  asks: PolymarketOrderbookEntry[];
  timestamp: string;
  hash: string;
}

export interface PriceChangeMessage {
  event_type: 'price_change';
  asset_id: string;
  market: string;
  price: string;
  timestamp: string;
}

export type PolymarketWsMessage = BookUpdateMessage | PriceChangeMessage;
