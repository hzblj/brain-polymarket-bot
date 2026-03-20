import { Module } from '@nestjs/common';
import { AgentGatewayModule } from './agent-gateway.module';

@Module({
  imports: [AgentGatewayModule],
})
export class AppModule {}
