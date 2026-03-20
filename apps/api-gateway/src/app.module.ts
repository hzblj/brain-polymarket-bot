import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { GatewayModule } from './gateway.module';

@Module({
  imports: [
    HttpModule.register({
      timeout: 30_000,
      maxRedirects: 3,
    }),
    GatewayModule,
  ],
})
export class AppModule {}
