import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { performance } from 'perf_hooks';
import { PermissionsCacheService } from '../services/permissions-cache.service';
import { SupportSessionService } from '../support/support-session.service';
import {
  AuthenticatedUser,
  TenantContext,
} from '../types/tenant-context.interface';

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

type TimedRequest = Request & {
  requestTimings?: Record<string, number>;
  tenantContext?: TenantContext;
};

/**
 * Resuelve TenantContext a partir del JWT + headers y lo adjunta a `req.tenantContext`.
 * Reglas:
 *  - X-Tenant-Id requerido.
 *  - ROOT puede LEER cualquier tenantId/branchId.
 *  - Super-admin (ROOT o isPlatformAdmin) en un tenant ajeno: escribir exige una
 *    sesión de soporte viva; con ella actúa con poderes de ROOT y queda auditado.
 *  - Non-ROOT: X-Tenant-Id debe coincidir con user.tenantId.
 *  - X-Branch-Id (si viene) debe estar en userBranches — salvo ROOT.
 */
@Injectable()
export class TenantGuard implements CanActivate {
  constructor(
    private readonly permissionsCache: PermissionsCacheService,
    private readonly supportSessions: SupportSessionService,
  ) {}

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

    // Super-admin en un negocio ajeno: escribir exige una sesión de soporte viva.
    // Las lecturas sin sesión se mantienen para el backoffice (p. ej. insights).
    let supportSessionId: string | undefined;
    if (this.supportSessions.isCrossTenant(user, headerTenantId)) {
      const session = await this.supportSessions.findActive(user.id, headerTenantId);
      supportSessionId = session?.id;
      if (!session && !READ_METHODS.has(request.method)) {
        throw new ForbiddenException({
          code: 'SUPPORT_SESSION_REQUIRED',
          message: 'Abre una sesión de soporte para modificar datos de este negocio.',
        });
      }
    }
    const actsAsRoot = user.isRoot || !!supportSessionId;

    if (!actsAsRoot && user.tenantId !== headerTenantId) {
      throw new ForbiddenException('Tenant mismatch');
    }

    if (
      headerBranchId &&
      !actsAsRoot &&
      !user.accessibleBranches.includes(headerBranchId)
    ) {
      throw new ForbiddenException('Branch not accessible for this user');
    }

    const permissionsStart = performance.now();
    const permissions = actsAsRoot
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
      isRoot: actsAsRoot,
      permissions,
      accessibleBranches: user.accessibleBranches,
      supportSessionId,
    };

    request.tenantContext = tenantContext;
    request.requestTimings.tenantGuard = performance.now() - tenantStart;
    return true;
  }
}
