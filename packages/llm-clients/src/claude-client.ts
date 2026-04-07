import Anthropic from '@anthropic-ai/sdk';
import type { BrainLoggerService } from '@brain/logger';
import { Injectable } from '@nestjs/common';
import type { z } from 'zod';
import type { LlmClient, LlmClientOptions, LlmEvaluateOptions, LlmResponse } from './interface';
import { zodToJsonSchema } from './zod-to-json';

@Injectable()
export class ClaudeClient implements LlmClient {
  readonly provider = 'anthropic';
  private readonly client: Anthropic;
  private readonly logger: BrainLoggerService;
  private readonly model: string;
  private readonly maxRetries: number;
  private readonly timeoutMs: number;
  private readonly temperature: number;

  constructor(options: LlmClientOptions, logger: BrainLoggerService) {
    this.logger = logger.child('ClaudeClient');
    this.model = options.model;
    this.maxRetries = options.maxRetries;
    this.timeoutMs = options.timeoutMs;
    this.temperature = options.temperature;

    this.client = new Anthropic({
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
    const startTime = Date.now();
    const jsonSchema = zodToJsonSchema(schema);

    const effectiveRetries = options?.maxRetries ?? this.maxRetries;
    const effectiveTimeout = options?.timeoutMs ?? this.timeoutMs;
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= effectiveRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.warn('Retrying Claude evaluation', { attempt, maxRetries: effectiveRetries });
        }

        const response = await this.client.messages.create(
          {
            model: this.model,
            max_tokens: 2048,
            temperature: this.temperature,
            system: systemPrompt,
            messages: [{ role: 'user', content: userPrompt }],
            tools: [
              {
                name: 'structured_output',
                description: 'Return your analysis as structured data matching the schema.',
                input_schema: jsonSchema as Anthropic.Messages.Tool['input_schema'],
              },
            ],
            tool_choice: { type: 'tool', name: 'structured_output' },
          },
          { timeout: effectiveTimeout },
        );

        const toolUseBlock = response.content.find((block) => block.type === 'tool_use');
        if (!toolUseBlock || toolUseBlock.type !== 'tool_use') {
          throw new Error('Claude did not return a tool_use response');
        }

        const parsed = schema.parse(toolUseBlock.input);
        const latencyMs = Date.now() - startTime;

        this.logger.debug('Claude evaluation complete', {
          model: this.model,
          latencyMs,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        });

        return {
          data: parsed,
          model: this.model,
          provider: this.provider,
          latencyMs,
          inputTokens: response.usage.input_tokens,
          outputTokens: response.usage.output_tokens,
        };
      } catch (err) {
        lastError = err as Error;
        this.logger.error('Claude evaluation error', lastError.message, { attempt });

        if (attempt < effectiveRetries) {
          const backoffMs = Math.min(1000 * 2 ** attempt, 10000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw new Error(
      `Claude evaluation failed after ${effectiveRetries + 1} attempts: ${lastError?.message}`,
    );
  }
}
