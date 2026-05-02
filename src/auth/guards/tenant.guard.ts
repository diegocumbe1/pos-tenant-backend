import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { performance } from 'perf_hooks';
import { PermissionsCacheService } from '../services/permissions-cache.service';
import {
  AuthenticatedUser,
  TenantContext,
} from '../types/tenant-context.interface';

type TimedRequest = Request & {
  requestTimings?: Record<string, number>;
  tenantContext?: TenantContext;
};

/**
 * Resuelve TenantContext a partir del JWT + headers y lo adjunta a `req.tenantContext`.
 * Reglas:
 *  - X-Tenant-Id requerido.
 *  - ROOT puede impersonar cualquier tenantId/branchId.
 *  - Non-ROOT: X-Tenant-Id debe coincidir con user.tenantId.
 *  - X-Branch-Id (si viene) debe estar en userBranches — salvo ROOT.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly permissionsCache: PermissionsCacheService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TimedRequest>();
    request.requestTimings ??= {};
    const tenantStart = performance.now();
    const user = request.user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('No authenticated user');

    const headerTenantId = request.headers['x-tenant-id'] as string | undefined;
    const headerBranchId = request.headers['x-branch-id'] as string | undefined;

    if (!headerTenantId) {
      throw new ForbiddenException('Missing X-Tenant-Id header');
    }

    if (!user.isRoot && user.tenantId !== headerTenantId) {
      throw new ForbiddenException('Tenant mismatch');
    }

    if (
      headerBranchId &&
      !user.isRoot &&
      !user.accessibleBranches.includes(headerBranchId)
    ) {
      throw new ForbiddenException('Branch not accessible for this user');
    }

    const permissionsStart = performance.now();
    const permissions = user.isRoot
      ? new Set<string>() // ROOT bypasea checks, no hace falta cargarlos
      : await this.permissionsCache.getForRole(user.roleId);
    request.requestTimings.tenantPermissions =
      performance.now() - permissionsStart;

    const tenantContext: TenantContext = {
      userId: user.id,
      email: user.email,
      name: user.name,
      tenantId: headerTenantId,
      branchId: headerBranchId ?? '',
      roleId: user.roleId,
      roleCode: user.roleCode,
      isRoot: user.isRoot,
      permissions,
      accessibleBranches: user.accessibleBranches,
    };

    request.tenantContext = tenantContext;
    request.requestTimings.tenantGuard = performance.now() - tenantStart;
    return true;
  }
}
