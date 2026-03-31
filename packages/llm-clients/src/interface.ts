import type { z } from 'zod';

export interface LlmClientOptions {
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  temperature: number;
}

export interface LlmResponse<T> {
  data: T;
  model: string;
  provider: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
}

export interface LlmClient {
  readonly provider: string;
  evaluate<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    options?: { model?: string },
  ): Promise<LlmResponse<T>>;
}
