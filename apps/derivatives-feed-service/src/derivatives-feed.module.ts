import { Module } from '@nestjs/common';
import { DerivativesFeedController } from './derivatives-feed.controller';
import { DerivativesFeedService } from './derivatives-feed.service';

@Module({
  controllers: [DerivativesFeedController],
  providers: [DerivativesFeedService],
  exports: [DerivativesFeedService],
})
export class DerivativesFeedModule {}
