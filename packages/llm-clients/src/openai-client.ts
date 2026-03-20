import { Injectable } from '@nestjs/common';
import OpenAI from 'openai';
import type { z } from 'zod';
import { zodToJsonSchema } from './zod-to-json';
import { BrainLoggerService } from '@brain/logger';
import type { LlmClient, LlmClientOptions, LlmResponse } from './interface';

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
  ): Promise<LlmResponse<T>> {
    const startTime = Date.now();
    const jsonSchema = zodToJsonSchema(schema);

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        if (attempt > 0) {
          this.logger.warn('Retrying OpenAI evaluation', { attempt, maxRetries: this.maxRetries });
        }

        const response = await this.client.chat.completions.create({
          model: this.model,
          temperature: this.temperature,
          max_tokens: 2048,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
          tools: [
            {
              type: 'function',
              function: {
                name: 'structured_output',
                description: 'Return your analysis as structured data matching the schema.',
                parameters: jsonSchema,
              },
            },
          ],
          tool_choice: { type: 'function', function: { name: 'structured_output' } },
        });

        const message = response.choices[0]?.message;
        if (!message) {
          throw new Error('OpenAI returned no choices');
        }

        const toolCall = message.tool_calls?.[0];
        if (!toolCall || toolCall.function.name !== 'structured_output') {
          throw new Error('OpenAI did not return expected tool call');
        }

        const rawOutput = JSON.parse(toolCall.function.arguments);
        const parsed = schema.parse(rawOutput);
        const latencyMs = Date.now() - startTime;

        const usage = response.usage;

        this.logger.debug('OpenAI evaluation complete', {
          model: this.model,
          latencyMs,
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
        });

        return {
          data: parsed,
          model: this.model,
          provider: this.provider,
          latencyMs,
          inputTokens: usage?.prompt_tokens ?? 0,
          outputTokens: usage?.completion_tokens ?? 0,
        };
      } catch (err) {
        lastError = err as Error;
        this.logger.error('OpenAI evaluation error', lastError.message, { attempt });

        if (attempt < this.maxRetries) {
          const backoffMs = Math.min(1000 * Math.pow(2, attempt), 10000);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }

    throw new Error(`OpenAI evaluation failed after ${this.maxRetries + 1} attempts: ${lastError?.message}`);
  }
}
