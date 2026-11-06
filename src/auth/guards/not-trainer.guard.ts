import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { TRAINER_ROLE_CODE } from '../trainer-role';
import { TenantContext } from '../types/tenant-context.interface';

/**
 * Lo que cuelga del permiso de agenda pero no le toca al entrenador: cobros,
 * saldos, citas y reservas de los demás. Va después de TenantGuard.
 */
@Injectable()
export class NotTrainerGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context
      .switchToHttp()
      .getRequest<{ tenantContext?: TenantContext }>();
    if (request.tenantContext?.roleCode === TRAINER_ROLE_CODE) {
      throw new ForbiddenException('Tu rol solo ve tus clases');
    }
    return true;
  }
}
