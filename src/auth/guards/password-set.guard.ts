import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthenticatedUser } from '../types/tenant-context.interface';

export const ALLOW_WITHOUT_PASSWORD_KEY = 'allowWithoutPassword';

/**
 * Decorator que permite que un endpoint sea accedido por usuarios invitados
 * antes de que hayan completado el flujo de acceptar invite + set password.
 * Lo usamos en `/auth/accept-invite` y `/auth/me`.
 */
import { SetMetadata } from '@nestjs/common';
export const AllowWithoutPassword = () =>
  SetMetadata(ALLOW_WITHOUT_PASSWORD_KEY, true);

@Injectable()
export class PasswordSetGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const allow = this.reflector.getAllAndOverride<boolean | undefined>(
      ALLOW_WITHOUT_PASSWORD_KEY,
      [ctx.getHandler(), ctx.getClass()],
    );
    if (allow) return true;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) return true; // que otros guards se encarguen
    if (user.isRoot) return true; // ROOT ya bootstrapeado manualmente
    if (!user.passwordSetAt) {
      throw new ForbiddenException({
        code: 'PASSWORD_SETUP_REQUIRED',
        message: 'Complete invitation: set password via POST /auth/accept-invite',
      });
    }
    return true;
  }
}
