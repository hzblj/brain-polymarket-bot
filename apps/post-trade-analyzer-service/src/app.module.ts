import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { LlmClientsModule } from '@brain/llm-clients';
import { LoggerModule } from '@brain/logger';
import { Module } from '@nestjs/common';
import { PostTradeAnalyzerModule } from './post-trade-analyzer.module';

@Module({
  imports: [
    EventBusModule,
    LoggerModule.forService('post-trade-analyzer'),
    DatabaseModule.forRoot(),
    LlmClientsModule.forRoot({
      openai: {
        apiKey: process.env.OPENAI_API_KEY ?? '',
        model: process.env.ANALYZER_MODEL ?? 'gpt-4o',
        timeoutMs: process.env.ANALYZER_TIMEOUT_MS
          ? parseInt(process.env.ANALYZER_TIMEOUT_MS, 10)
          : 60000,
        maxRetries: 2,
        temperature: 0,
      },
    }),
    PostTradeAnalyzerModule,
  ],
})
export class AppModule {}
