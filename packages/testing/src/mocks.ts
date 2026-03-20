import type { UnixMs, PriceSource } from '@brain/types';

// ─── Mock EventBus ──────────────────────────────────────────────────────────

export class MockEventBus {
  private events: Array<{ event: string; payload: unknown }> = [];

  emit(event: string, payload: unknown): boolean {
    this.events.push({ event, payload });
    return true;
  }

  on(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  once(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  off(_event: string, _listener: (...args: unknown[]) => void): this {
    return this;
  }

  removeAllListeners(): this {
    return this;
  }

  listenerCount(): number {
    return 0;
  }

  getEmittedEvents(): Array<{ event: string; payload: unknown }> {
    return [...this.events];
  }

  getEmittedByType(event: string): unknown[] {
    return this.events.filter((e) => e.event === event).map((e) => e.payload);
  }

  clearEvents(): void {
    this.events = [];
  }
}

// ─── Mock Logger Service ────────────────────────────────────────────────────

export class MockLoggerService {
  private logs: Array<{ level: string; message: string; data?: unknown }> = [];

  child(_context: string): MockLoggerService {
    return this;
  }

  log(message: string, ...args: unknown[]): void {
    this.logs.push({ level: 'info', message, data: args[0] });
  }

  info(message: string, data?: unknown): void {
    this.logs.push({ level: 'info', message, data });
  }

  error(message: string, _trace?: string, ...args: unknown[]): void {
    this.logs.push({ level: 'error', message, data: args[0] });
  }

  warn(message: string, ...args: unknown[]): void {
    this.logs.push({ level: 'warn', message, data: args[0] });
  }

  debug(message: string, data?: unknown): void {
    this.logs.push({ level: 'debug', message, data });
  }

  verbose(message: string, ...args: unknown[]): void {
    this.logs.push({ level: 'verbose', message, data: args[0] });
  }

  fatal(message: string, data?: unknown): void {
    this.logs.push({ level: 'fatal', message, data });
  }

  getLogs(): Array<{ level: string; message: string; data?: unknown }> {
    return [...this.logs];
  }

  getLogsByLevel(level: string): Array<{ level: string; message: string; data?: unknown }> {
    return this.logs.filter((l) => l.level === level);
  }

  clearLogs(): void {
    this.logs = [];
  }
}

// ─── Mock LLM Client ───────────────────────────────────────────────────────

export class MockLlmClient {
  readonly provider = 'mock';
  private responses: unknown[] = [];
  private callCount = 0;

  setResponse(response: unknown): void {
    this.responses = [response];
  }

  setResponses(responses: unknown[]): void {
    this.responses = responses;
  }

  async evaluate<T>(
    _systemPrompt: string,
    _userPrompt: string,
    _schema: unknown,
  ): Promise<{ data: T; model: string; provider: string; latencyMs: number; inputTokens: number; outputTokens: number }> {
    const responseIndex = Math.min(this.callCount, this.responses.length - 1);
    const response = this.responses[responseIndex];
    this.callCount++;

    if (!response) {
      throw new Error('MockLlmClient: no response configured');
    }

    return {
      data: response as T,
      model: 'mock-model',
      provider: 'mock',
      latencyMs: 100,
      inputTokens: 500,
      outputTokens: 200,
    };
  }

  getCallCount(): number {
    return this.callCount;
  }

  reset(): void {
    this.callCount = 0;
    this.responses = [];
  }
}

// ─── Mock PriceFeed Client ──────────────────────────────────────────────────

export class MockPriceFeedClient {
  readonly source: PriceSource;
  private connected = false;
  private handlers = new Set<(tick: { source: PriceSource; price: number; bid: number; ask: number; eventTime: UnixMs }) => void>();

  constructor(source: PriceSource = 'binance') {
    this.source = source;
  }

  get isConnected(): boolean {
    return this.connected;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  disconnect(): void {
    this.connected = false;
    this.handlers.clear();
  }

  onTick(handler: (tick: { source: PriceSource; price: number; bid: number; ask: number; eventTime: UnixMs }) => void): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  simulateTick(price: number, spread: number = 1): void {
    const tick = {
      source: this.source,
      price,
      bid: price - spread / 2,
      ask: price + spread / 2,
      eventTime: Date.now(),
    };
    for (const handler of this.handlers) {
      handler(tick);
    }
  }
}
