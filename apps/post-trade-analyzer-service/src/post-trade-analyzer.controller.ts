import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from '@nestjs/common';
import { PostTradeAnalyzerService } from './post-trade-analyzer.service';
import type { AnalyzeRequest, AnalyzeWindowRequest } from './post-trade-analyzer.service';

@Controller('api/v1/analyzer')
export class PostTradeAnalyzerController {
  constructor(
    @Inject(PostTradeAnalyzerService)
    private readonly analyzerService: PostTradeAnalyzerService,
  ) {}

  @Post('analyze')
  @HttpCode(200)
  async analyze(@Body() body: AnalyzeRequest) {
    const analysis = await this.analyzerService.analyze(body);
    return { ok: true, data: analysis };
  }

  @Post('analyze-window')
  @HttpCode(200)
  async analyzeWindow(@Body() body: AnalyzeWindowRequest) {
    const analyses = await this.analyzerService.analyzeWindow(body);
    return { ok: true, data: analyses };
  }

  @Get('analyses')
  async listAnalyses(
    @Query('windowId') windowId?: string,
    @Query('verdict') verdict?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit') limit?: string,
  ) {
    const analyses = await this.analyzerService.listAnalyses({
      windowId,
      verdict,
      from,
      to,
      limit: limit ? parseInt(limit, 10) : 50,
    });
    return { ok: true, data: analyses };
  }

  @Get('analyses/:id')
  async getAnalysis(@Param('id') id: string) {
    const analysis = await this.analyzerService.getAnalysis(id);
    return { ok: true, data: analysis };
  }
}
