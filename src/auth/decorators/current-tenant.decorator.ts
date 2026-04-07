import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { Request } from 'express';
import { JwtPayload } from '../types/jwt-payload.interface';
import { TenantContext } from '../types/tenant-context.interface';

/**
 * Extracts tenant context from the current request.
 * Combines JWT claims (tenantId, userId, role) with headers (branchId).
 *
 * Usage: @CurrentTenant() ctx: TenantContext
 */
export const CurrentTenant = createParamDecorator(
  (_data: unknown, context: ExecutionContext): TenantContext => {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as JwtPayload;
    const branchId = request.headers['x-branch-id'] as string;

    return {
      userId: user.sub,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      branchId,
      role: user.role,
    };
  },
);
