import {
  createParamDecorator,
  ExecutionContext,
  InternalServerErrorException,
} from '@nestjs/common';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';

/**
 * Inyecta el platform admin autenticado (actor) en los endpoints `/platform/*`.
 * Usar encadenado a `JwtAuthGuard` + `PlatformAdminGuard`.
 */
export const PlatformActor = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser => {
    const req = context
      .switchToHttp()
      .getRequest<Request & { user?: AuthenticatedUser }>();
    if (!req.user) {
      throw new InternalServerErrorException(
        'Platform actor missing — ensure JwtAuthGuard + PlatformAdminGuard are applied',
      );
    }
    return req.user;
  },
);
