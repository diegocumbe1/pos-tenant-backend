import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../auth/guards/password-set.guard';
import { TenantGuard } from '../../auth/guards/tenant.guard';
import { TenantContext } from '../../auth/types/tenant-context.interface';

/**
 * Autenticación opcional para los avisos de cita.
 *
 * Esos endpoints los llaman dos pantallas: el POS (con sesión) y la
 * confirmación de la reserva pública, que abre un cliente final sin cuenta. Un
 * guard JWT a secas rompería la segunda.
 *
 * Si llega un token y resuelve a un tenant válido, la petición sigue como
 * autenticada (`req.tenantContext`). Si no hay token, o no sirve para ese tenant
 * —p. ej. un usuario de otro negocio reservando aquí—, NO se rechaza: pasa como
 * pública, y el controller le aplica las reglas restringidas de ese camino
 * (sede real, aviso activado por el negocio, número del negocio desde la base,
 * tope de envíos). Nunca se cae al tenant de demo.
 */
@Injectable()
export class OptionalTenantAuthGuard implements CanActivate {
  constructor(
    private readonly jwt: JwtAuthGuard,
    private readonly passwordSet: PasswordSetGuard,
    private readonly tenant: TenantGuard,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: TenantContext }>();
    if (!req.headers.authorization) return true;

    try {
      await this.jwt.canActivate(context);
      this.passwordSet.canActivate(context);
      await this.tenant.canActivate(context);
    } catch {
      // Un contexto a medio resolver no puede quedar colgado de la petición.
      req.tenantContext = undefined;
    }
    return true;
  }
}
