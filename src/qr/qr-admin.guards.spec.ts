import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard';

/**
 * Quién puede administrar un QR.
 *
 * Se prueba el guard suelto y no el controller: importar `QrAdminController`
 * arrastra `JwtAuthGuard` → `jose`, que es ESM y el jest de este repo no
 * transforma. Lo que decide el permiso es igualmente esto.
 */
const contextWith = (user?: Partial<AuthenticatedUser>): ExecutionContext =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  }) as unknown as ExecutionContext;

describe('Permisos del QR (PlatformAdminGuard)', () => {
  const guard = new PlatformAdminGuard();

  it('un usuario normal del tenant no administra el QR de su negocio', () => {
    // Rotar un código deja tarjetas impresas muertas: no es una acción de
    // dueño de negocio, es de plataforma.
    expect(() =>
      guard.canActivate(contextWith({ id: 'u1', isPlatformAdmin: false })),
    ).toThrow(ForbiddenException);
  });

  it('el superadmin sí', () => {
    expect(
      guard.canActivate(contextWith({ id: 'root', isPlatformAdmin: true })),
    ).toBe(true);
  });

  it('sin sesión tampoco', () => {
    expect(() => guard.canActivate(contextWith(undefined))).toThrow(
      ForbiddenException,
    );
  });
});
