import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { AgentGatewayModule } from './agent-gateway.module';

@Module({
  imports: [DatabaseModule.forRoot(), AgentGatewayModule],
})
export class AppModule {}
