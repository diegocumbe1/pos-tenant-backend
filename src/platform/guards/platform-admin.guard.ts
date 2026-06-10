import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';

/**
 * Protege los endpoints `/platform/*` (cross-tenant, super-admin).
 *
 * - NO pasa por TenantGuard: los endpoints de plataforma no exigen X-Tenant-Id.
 * - Exige `req.user.isPlatformAdmin === true` (el ROOT ya viene marcado como tal).
 * - Sin el claim → 403.
 *
 * Encadenar SIEMPRE después de `JwtAuthGuard` para que `req.user` esté poblado.
 * Ver docs/BACKOFFICE_ARCHITECTURE.md §2 / §10.3.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<{ user?: AuthenticatedUser }>();
    const user = req.user;
    if (!user) {
      throw new ForbiddenException('No authenticated user');
    }
    if (!user.isPlatformAdmin) {
      throw new ForbiddenException({
        code: 'NOT_PLATFORM_ADMIN',
        message: 'Platform admin privileges required',
      });
    }
    return true;
  }
}
