import type { BrainLoggerService } from '@brain/logger';
import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { z } from 'zod';
import type { LlmClient, LlmClientOptions, LlmEvaluateOptions, LlmResponse, ReasoningEffort } from './interface';
import { zodToJsonSchema } from './zod-to-json';

@Injectable()
export class OpenAIClient implements LlmClient {
  readonly provider = 'openai';
  private readonly client: OpenAI;
  private readonly logger: BrainLoggerService;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly temperature: number;

  constructor(options: LlmClientOptions, logger: BrainLoggerService) {
    this.logger = logger.child('OpenAIClient');
    this.model = options.model;
    this.maxRetries = options.maxRetries;
    this.timeoutMs = options.timeoutMs;
    this.temperature = options.temperature;

    this.client = new OpenAI({
      apiKey: options.apiKey,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
  }

  async evaluate<T>(
    systemPrompt: string,
    userPrompt: string,
    schema: z.ZodSchema<T>,
    options?: LlmEvaluateOptions,
  ): Promise<LlmResponse<T>> {
    const useModel = options?.model ?? this.model;
    const startTime = Date.now();
    const jsonSchema = zodToJsonSchema(schema);
    const reasoningEffort = options?.reasoningEffort;

    const effectiveRetries = options?.maxRetries ?? this.maxRetries;
    const effectiveTimeout = options?.timeoutMs ?? this.timeoutMs;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.warn('Retrying OpenAI evaluation', { attempt, maxRetries: effectiveRetries });
        }

        const response = await this.client.responses.create(
          {
            model: useModel,
            instructions: systemPrompt,
            input: [{ role: 'user', content: userPrompt }],
            ...(/^(o1|o3|o4|gpt-5)/.test(useModel) ? {} : { temperature: this.temperature }),
            ...(reasoningEffort ? { reasoning: { effort: reasoningEffort } } : {}),
            max_output_tokens: 2048,
            tools: [
              {
                type: 'function' as const,
                name: 'structured_output',
                description: 'Return your analysis as structured data matching the schema.',
                parameters: jsonSchema,
                strict: true,
              },
            ],
            tool_choice: { type: 'function', name: 'structured_output' },
            store: false,
          },
          { timeout: effectiveTimeout },
        );

        // Find the function_call output item
        const functionCall = response.output.find(
          (item): item is Extract<typeof item, { type: 'function_call' }> =>
            item.type === 'function_call' && item.name === 'structured_output',
        );

        if (!functionCall) {
          const outputTypes = response.output.map((item) => item.type).join(', ');
          const textContent = response.output
            .filter((item): item is Extract<typeof item, { type: 'message' }> => item.type === 'message')
            .map((item) => item.content?.map((c: Record<string, unknown>) => c.text).join(''))
            .join('\n');
          this.logger.error('OpenAI did not return function_call', { outputTypes, textContent: textContent?.slice(0, 500) });
          throw new Error(`OpenAI did not return expected function_call output. Got: [${outputTypes}]`);
        }

        const rawOutput = JSON.parse(functionCall.arguments);
        const parsed = schema.parse(rawOutput);
        const latencyMs = Date.now() - startTime;

        const usage = response.usage;

        this.logger.debug('OpenAI evaluation complete', {
          model: useModel,
          latencyMs,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        });

        return {
          data: parsed,
          model: useModel,
          provider: this.provider,
          latencyMs,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
        };
      } catch (err) {
        lastError = err as Error;
        this.logger.error('OpenAI evaluation error', lastError.message, { attempt });

        if (attempt < effectiveRetries) {
          const backoffMs = Math.min(1000 * 2 ** attempt, 10000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw new Error(
      `OpenAI evaluation failed after ${effectiveRetries + 1} attempts: ${lastError?.message}`,
    );
  }
}
