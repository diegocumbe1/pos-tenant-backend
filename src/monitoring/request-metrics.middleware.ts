import { Injectable, NestMiddleware } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { NextFunction, Request, Response } from 'express';
import { performance } from 'perf_hooks';
import { RequestMetricsStore } from './request-metrics.store';

@Injectable()
export class RequestMetricsMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    RequestMetricsStore.run(
      {
        requestId: randomUUID(),
        startedAt: performance.now(),
        prismaQueryCount: 0,
        prismaDbTimeMs: 0,
        slowestPrismaQueryMs: 0,
        timings: {},
      },
      next,
    );
  }
}
