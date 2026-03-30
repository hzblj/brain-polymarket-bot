import { Module } from '@nestjs/common';
import { PostTradeAnalyzerController } from './post-trade-analyzer.controller';
import { PostTradeAnalyzerService } from './post-trade-analyzer.service';

@Module({
  controllers: [PostTradeAnalyzerController],
  providers: [PostTradeAnalyzerService],
  exports: [PostTradeAnalyzerService],
})
export class PostTradeAnalyzerModule {}
