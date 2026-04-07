import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { JwtPayload } from '../types/jwt-payload.interface';

/**
 * Validates that X-Tenant-Id header matches the tenantId from JWT.
 * Prevents cross-tenant access even with a valid token.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const user = request.user as JwtPayload;
    const headerTenantId = request.headers['x-tenant-id'] as string;

    if (!headerTenantId) {
      throw new ForbiddenException('Missing X-Tenant-Id header');
    }

    if (user.tenantId !== headerTenantId) {
      throw new ForbiddenException('Tenant mismatch');
    }

    return true;
  }
}
