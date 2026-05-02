import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { TenantContext } from '../types/tenant-context.interface';

/**
 * Inyecta el `TenantContext` resuelto por `TenantGuard`.
 * Usar siempre encadenado a `JwtAuthGuard` + `TenantGuard`, si no `tenantContext` no estará poblado.
 *
 * Usage: @CurrentTenant() ctx: TenantContext
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<
      Request & { tenantContext?: TenantContext }
    >();
    if (!request.tenantContext) {
      throw new InternalServerErrorException(
        'TenantContext missing — ensure TenantGuard is applied before @CurrentTenant',
      );
    }
    return request.tenantContext;
  },
);
