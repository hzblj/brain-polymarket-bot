import { DatabaseModule } from '@brain/database';
import { EventBusModule } from '@brain/events';
import { LlmClientsModule } from '@brain/llm-clients';
import { LoggerModule } from '@brain/logger';
import { Module } from '@nestjs/common';
import { AgentGatewayModule } from './agent-gateway.module';

@Module({
  imports: [
    EventBusModule,
    LoggerModule.forService('agent-gateway'),
    DatabaseModule.forRoot(),
    LlmClientsModule.forRoot({
      openai: {
        apiKey: process.env.OPENAI_API_KEY ?? '',
        model: process.env.AGENT_MODEL ?? 'gpt-4o',
        timeoutMs: process.env.AGENT_TIMEOUT_MS ? parseInt(process.env.AGENT_TIMEOUT_MS, 10) : 30000,
        maxRetries: process.env.AGENT_MAX_RETRIES ? parseInt(process.env.AGENT_MAX_RETRIES, 10) : 2,
        temperature: process.env.AGENT_TEMPERATURE ? parseFloat(process.env.AGENT_TEMPERATURE) : 0,
      },
    }),
    AgentGatewayModule,
  ],
})
export class AppModule {}
