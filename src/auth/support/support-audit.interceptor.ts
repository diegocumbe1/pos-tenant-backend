import {
  CallHandler,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request, Response } from 'express';
import { performance } from 'perf_hooks';
import { Observable, tap } from 'rxjs';
import { TenantContext } from '../types/tenant-context.interface';
import { SupportSessionService } from './support-session.service';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Efectos secundarios del navegador, no acciones de la persona.
const IGNORED_PATHS = [/\/assistant\/telemetry(\?|$)/];

/**
 * Registra cada escritura hecha dentro de una sesión de soporte. Corre después
 * de los guards, así que solo ve requests que `TenantGuard` ya asoció a una
 * sesión viva (`tenantContext.supportSessionId`).
 */
@Injectable()
export class SupportAuditInterceptor implements NestInterceptor {
  constructor(private readonly supportSessions: SupportSessionService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request & { tenantContext?: TenantContext }>();
    const sessionId = req.tenantContext?.supportSessionId;
    if (
      !sessionId ||
      READ_METHODS.has(req.method) ||
      IGNORED_PATHS.some((pattern) => pattern.test(req.originalUrl))
    ) {
      return next.handle();
    }

    const res = http.getResponse<Response>();
    const startedAt = performance.now();
    const record = (statusCode: number) =>
      void this.supportSessions.recordAction({
        sessionId,
        method: req.method,
        path: req.originalUrl,
        statusCode,
        durationMs: performance.now() - startedAt,
        body: req.body,
      });

    return next.handle().pipe(
      tap({
        next: () => record(res.statusCode),
        error: (error: unknown) =>
          record(error instanceof HttpException ? error.getStatus() : 500),
      }),
    );
  }
}
