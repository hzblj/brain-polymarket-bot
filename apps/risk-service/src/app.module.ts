import { DatabaseModule } from '@brain/database';
import { Module } from '@nestjs/common';
import { RiskModule } from './risk.module';

@Module({
  imports: [DatabaseModule.forRoot(), RiskModule],
})
export class AppModule {}
