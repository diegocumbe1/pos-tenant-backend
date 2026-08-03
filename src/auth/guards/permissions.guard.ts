import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  REQUIRE_ANY_PERMISSION_KEY,
  REQUIRE_PERMISSIONS_KEY,
} from '../decorators/require-permissions.decorator';
import { PermissionsCacheService } from '../services/permissions-cache.service';
import {
  AuthenticatedUser,
  TenantContext,
} from '../types/tenant-context.interface';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly permissionsCache: PermissionsCacheService,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const all = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRE_PERMISSIONS_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    const any = this.reflector.getAllAndOverride<string[] | undefined>(
      REQUIRE_ANY_PERMISSION_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    // `any` gana cuando el endpoint declara ambos: es el caso de los módulos
    // compartidos, donde cada vertical trae su propio permiso.
    const mode: 'all' | 'any' = any && any.length > 0 ? 'any' : 'all';
    const required = mode === 'any' ? any : all;
    if (!required || required.length === 0) return true;

    const req = ctx.switchToHttp().getRequest();
    const user: AuthenticatedUser | undefined = req.user;
    if (!user) throw new ForbiddenException('No authenticated user');
    if (user.isRoot) return true;

    const tenantContext = req.tenantContext as TenantContext | undefined;
    const perms =
      tenantContext?.roleId === user.roleId
        ? tenantContext.permissions
        : await this.permissionsCache.getForRole(user.roleId);
    if (mode === 'any') {
      if (required.some((code) => perms.has(code))) return true;
      throw new ForbiddenException(
        `Missing permission(s): one of ${required.join(', ')}`,
      );
    }

    const missing = required.filter((code) => !perms.has(code));
    if (missing.length > 0) {
      throw new ForbiddenException(
        `Missing permission(s): ${missing.join(', ')}`,
      );
    }
    return true;
  }
}
