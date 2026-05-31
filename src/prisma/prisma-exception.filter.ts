import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import { Prisma } from '@prisma/client';

type ErrorPayload = {
  statusCode: number;
  error: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
};

/**
 * Convierte errores conocidos de Prisma en respuestas HTTP claras.
 *
 * Sin este filter:
 *   - P2002 (unique violation)  → 500 "Internal server error"
 *   - P2025 (record not found)  → 500
 *   - P2003 (FK violation)      → 500
 *
 * Con este filter:
 *   - P2002 → 409 Conflict + qué campos colisionan
 *   - P2025 → 404 Not Found
 *   - P2003 → 409 Conflict (FK rota)
 *   - Otros knownRequestError → 400 con el code
 */
@Catch(Prisma.PrismaClientKnownRequestError, Prisma.PrismaClientValidationError)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  constructor(private readonly httpAdapterHost: HttpAdapterHost) {}

  catch(
    exception:
      | Prisma.PrismaClientKnownRequestError
      | Prisma.PrismaClientValidationError,
    host: ArgumentsHost,
  ) {
    const { httpAdapter } = this.httpAdapterHost;
    const ctx = host.switchToHttp();

    const payload = this.toPayload(exception);

    this.logger.warn(
      `Prisma error mapped to HTTP ${payload.statusCode} code=${payload.code} message="${payload.message}"`,
    );

    httpAdapter.reply(ctx.getResponse(), payload, payload.statusCode);
  }

  private toPayload(
    exception:
      | Prisma.PrismaClientKnownRequestError
      | Prisma.PrismaClientValidationError,
  ): ErrorPayload {
    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        statusCode: HttpStatus.BAD_REQUEST,
        error: 'Bad Request',
        code: 'PRISMA_VALIDATION',
        message: 'Invalid data sent to database',
      };
    }

    const meta = exception.meta ?? {};

    switch (exception.code) {
      case 'P2002': {
        const target = Array.isArray(meta.target)
          ? (meta.target as string[])
          : typeof meta.target === 'string'
            ? [meta.target]
            : [];
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: 'UNIQUE_CONSTRAINT_VIOLATION',
          message:
            target.length > 0
              ? `A record with the same ${target.join(', ')} already exists`
              : 'A record with the same unique fields already exists',
          details: { fields: target, modelName: meta.modelName },
        };
      }

      case 'P2025':
        return {
          statusCode: HttpStatus.NOT_FOUND,
          error: 'Not Found',
          code: 'RECORD_NOT_FOUND',
          message:
            typeof meta.cause === 'string' ? meta.cause : 'Record not found',
          details: { modelName: meta.modelName },
        };

      case 'P2003':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: 'FOREIGN_KEY_CONSTRAINT_VIOLATION',
          message: 'Related record is missing or in use',
          details: { field: meta.field_name, modelName: meta.modelName },
        };

      case 'P2014':
        return {
          statusCode: HttpStatus.CONFLICT,
          error: 'Conflict',
          code: 'RELATION_VIOLATION',
          message: 'Operation violates a required relation',
          details: { modelName: meta.modelName, relationName: meta.relation_name },
        };

      default:
        return {
          statusCode: HttpStatus.BAD_REQUEST,
          error: 'Bad Request',
          code: exception.code,
          message: exception.message.split('\n').pop() ?? exception.message,
          details: { modelName: meta.modelName },
        };
    }
  }
}
