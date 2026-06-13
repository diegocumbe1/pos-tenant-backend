import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  Logger,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { performance } from 'perf_hooks';
import { Observable, tap } from 'rxjs';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { RequestMetricsStore } from './request-metrics.store';

type RequestWithContext = Request & {
  tenantContext?: TenantContext;
  requestTimings?: Record<string, number>;
};

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const http = context.switchToHttp();
    const req = http.getRequest<RequestWithContext>();
    const res = http.getResponse<Response>();
    const handlerStartedAt = performance.now();

    return next.handle().pipe(
      tap({
        next: () => this.log(req, res, handlerStartedAt),
        error: (error) => this.log(req, res, handlerStartedAt, error),
      }),
    );
  }

  private log(
    req: RequestWithContext,
    res: Response,
    handlerStartedAt: number,
    error?: unknown,
  ): void {
    const metrics = RequestMetricsStore.current();
    const totalMs = metrics
      ? performance.now() - metrics.startedAt
      : performance.now() - handlerStartedAt;
    const handlerMs = performance.now() - handlerStartedAt;
    const tenantId =
      req.tenantContext?.tenantId ?? (req.headers['x-tenant-id'] as string) ?? null;
    const branchId =
      req.tenantContext?.branchId ?? (req.headers['x-branch-id'] as string) ?? null;
    const statusCode = error
      ? this.statusFromError(error, res.statusCode)
      : res.statusCode;
    const requestId = metrics?.requestId;
    const prismaQueries = metrics?.prismaQueryCount ?? 0;
    const prismaDbMs = Math.round(metrics?.prismaDbTimeMs ?? 0);
    const prismaSlowestMs = Math.round(metrics?.slowestPrismaQueryMs ?? 0);
    const roundedTotalMs = Math.round(totalMs);
    const roundedHandlerMs = Math.round(handlerMs);

    this.setTimingHeaders(res, {
      requestId,
      totalMs: roundedTotalMs,
      handlerMs: roundedHandlerMs,
      prismaQueries,
      prismaDbMs,
      prismaSlowestMs,
    });

    const payload = {
      requestId,
      method: req.method,
      endpoint: req.originalUrl ?? req.url,
      statusCode,
      tenantId,
      branchId,
      totalMs: roundedTotalMs,
      handlerMs: roundedHandlerMs,
      prismaQueries,
      prismaDbMs,
      prismaSlowestMs,
      timings: { ...(req.requestTimings ?? {}), ...(metrics?.timings ?? {}) },
    };

    const message = JSON.stringify(payload);
    if (statusCode >= 500) {
      this.logger.error(message);
    } else if (error || statusCode >= 400) {
      this.logger.warn(message);
    } else if (totalMs >= 1000 || (metrics?.prismaDbTimeMs ?? 0) >= 500) {
      this.logger.warn(message);
    } else {
      this.logger.log(message);
    }
  }

  private statusFromError(error: unknown, currentStatus: number): number {
    if (error instanceof HttpException) return error.getStatus();
    if (currentStatus && currentStatus >= 400) return currentStatus;
    return 500;
  }

  private setTimingHeaders(
    res: Response,
    metrics: {
      requestId?: string;
      totalMs: number;
      handlerMs: number;
      prismaQueries: number;
      prismaDbMs: number;
      prismaSlowestMs: number;
    },
  ): void {
    if (res.headersSent) return;

    if (metrics.requestId) {
      res.setHeader('X-Request-Id', metrics.requestId);
    }
    res.setHeader('X-Request-Duration-Ms', String(metrics.totalMs));
    res.setHeader('X-Handler-Duration-Ms', String(metrics.handlerMs));
    res.setHeader('X-Prisma-Query-Count', String(metrics.prismaQueries));
    res.setHeader('X-Prisma-Db-Ms', String(metrics.prismaDbMs));
    res.setHeader('X-Prisma-Slowest-Ms', String(metrics.prismaSlowestMs));
    res.setHeader(
      'Server-Timing',
      [
        `app;dur=${metrics.totalMs}`,
        `handler;dur=${metrics.handlerMs}`,
        `db;dur=${metrics.prismaDbMs}`,
        `db_queries;desc="${metrics.prismaQueries}"`,
        `db_slowest;dur=${metrics.prismaSlowestMs}`,
      ].join(', '),
    );
  }
}
