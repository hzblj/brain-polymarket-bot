import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { LlmClientsModule } from '@brain/llm-clients';
import { LoggerModule } from '@brain/logger';
import { Module } from '@nestjs/common';
import { StrategyOptimizerModule } from './strategy-optimizer.module';

@Module({
  imports: [
    EventBusModule,
    LoggerModule.forService('strategy-optimizer'),
    DatabaseModule.forRoot(),
    LlmClientsModule.forRoot({
      openai: {
        apiKey: process.env.OPENAI_API_KEY ?? '',
        model: process.env.OPTIMIZER_MODEL ?? 'gpt-4o',
        timeoutMs: process.env.OPTIMIZER_TIMEOUT_MS
          ? parseInt(process.env.OPTIMIZER_TIMEOUT_MS, 10)
          : 120000,
        maxRetries: 2,
        temperature: 0.1,
      },
    }),
    StrategyOptimizerModule,
  ],
})
export class AppModule {}
