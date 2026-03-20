import { DynamicModule, Module } from '@nestjs/common';
import { BrainLoggerService } from '@brain/logger';
import { ClaudeClient } from './claude-client';
import { OpenAIClient } from './openai-client';
import type { LlmClientOptions } from './interface';

export interface LlmClientsModuleOptions {
  anthropic?: {
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    maxRetries?: number;
    temperature?: number;
  };
  openai?: {
    apiKey: string;
    model?: string;
    timeoutMs?: number;
    maxRetries?: number;
    temperature?: number;
  };
}

@Module({})
export class LlmClientsModule {
  static forRoot(options: LlmClientsModuleOptions): DynamicModule {
    const providers: DynamicModule['providers'] = [];
    const exports: DynamicModule['exports'] = [];

    if (options.anthropic) {
      const anthropicOptions: LlmClientOptions = {
        apiKey: options.anthropic.apiKey,
        model: options.anthropic.model ?? 'claude-sonnet-4-20250514',
        timeoutMs: options.anthropic.timeoutMs ?? 30000,
        maxRetries: options.anthropic.maxRetries ?? 2,
        temperature: options.anthropic.temperature ?? 0,
      };

      providers.push({
        provide: ClaudeClient,
        inject: [BrainLoggerService],
        useFactory: (logger: BrainLoggerService) => new ClaudeClient(anthropicOptions, logger),
      });
      exports.push(ClaudeClient);
    }

    if (options.openai) {
      const openaiOptions: LlmClientOptions = {
        apiKey: options.openai.apiKey,
        model: options.openai.model ?? 'gpt-4o',
        timeoutMs: options.openai.timeoutMs ?? 30000,
        maxRetries: options.openai.maxRetries ?? 2,
        temperature: options.openai.temperature ?? 0,
      };

      providers.push({
        provide: OpenAIClient,
        inject: [BrainLoggerService],
        useFactory: (logger: BrainLoggerService) => new OpenAIClient(openaiOptions, logger),
      });
      exports.push(OpenAIClient);
    }

    return {
      module: LlmClientsModule,
      global: true,
      providers,
      exports,
    };
  }
}
