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

export type ReasoningEffort = 'low' | 'medium' | 'high';

export interface LlmEvaluateOptions {
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export interface LlmClient {
  readonly provider: string;
  evaluate<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    options?: LlmEvaluateOptions,
  ): Promise<LlmResponse<T>>;
}
