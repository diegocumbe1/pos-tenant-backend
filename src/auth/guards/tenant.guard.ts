import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { performance } from 'perf_hooks';
import { PermissionsCacheService } from '../services/permissions-cache.service';
import { resolveTenantAccess } from '../helpers/tenant-access';
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
 *  - Non-ROOT: X-Tenant-Id debe ser su negocio principal (user.tenantId) o uno
 *    de sus accesos adicionales (user_tenant_memberships). Rol y sedes salen de
 *    ese negocio.
 *  - X-Branch-Id (si viene) debe ser una sede suya de ESE negocio — salvo ROOT.
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
      const session = await this.supportSessions.findActive(
        user.id,
        headerTenantId,
      );
      supportSessionId = session?.id;
      if (!session && !READ_METHODS.has(request.method)) {
        throw new ForbiddenException({
          code: 'SUPPORT_SESSION_REQUIRED',
          message:
            'Abre una sesión de soporte para modificar datos de este negocio.',
        });
      }
    }
    const actsAsRoot = user.isRoot || !!supportSessionId;

    // Negocio principal o uno adicional del switch (user_tenant_memberships).
    // El rol y las sedes son los de ESE negocio, no los del principal.
    const access = actsAsRoot
      ? null
      : resolveTenantAccess(user, headerTenantId);
    if (!actsAsRoot && !access) {
      throw new ForbiddenException('Tenant mismatch');
    }

    if (
      headerBranchId &&
      !actsAsRoot &&
      !access!.accessibleBranches.includes(headerBranchId)
    ) {
      throw new ForbiddenException('Branch not accessible for this user');
    }

    const roleId = access?.roleId ?? user.roleId;
    const roleCode = access?.roleCode ?? user.roleCode;

    const permissionsStart = performance.now();
    const permissions = actsAsRoot
      ? new Set<string>() // ROOT bypasea checks, no hace falta cargarlos
      : await this.permissionsCache.getForRole(roleId);
    request.requestTimings.tenantPermissions =
      performance.now() - permissionsStart;

    const tenantContext: TenantContext = {
      userId: user.id,
      email: user.email,
      name: user.name,
      tenantId: headerTenantId,
      branchId: headerBranchId ?? '',
      roleId,
      roleCode,
      isRoot: actsAsRoot,
      permissions,
      accessibleBranches: access?.accessibleBranches ?? user.accessibleBranches,
      supportSessionId,
    };

    request.tenantContext = tenantContext;
    request.requestTimings.tenantGuard = performance.now() - tenantStart;
    return true;
  }
}
