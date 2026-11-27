import {
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { WebPushProvider } from '../../notifications/web-push.provider';
import {
  ACTIVATION_REQUEST_ALERT,
  recordPlatformAlert,
} from '../../platform/alerts/platform-push';
import { PrismaService } from '../../prisma/prisma.service';
import { resolveTenantAccess } from '../helpers/tenant-access';
import { AuthenticatedUser } from '../types/tenant-context.interface';

/** Estados que permiten operar (mismo criterio que el login). */
export const ACTIVE_SUBSCRIPTION_STATUSES = ['TRIALING', 'ACTIVE', 'PAST_DUE'];

const VERTICAL_LABEL: Record<string, string> = {
  restaurant: 'Restaurante',
  barber: 'Agenda y reservas',
  retail: 'Tienda',
};

/** ¿El negocio NO puede operar? Misma regla que `assertTenantAccess`. */
export function isTenantLocked(tenant: {
  status: string;
  subscription: { status: string } | null;
}): boolean {
  return (
    tenant.status !== 'ACTIVE' ||
    !ACTIVE_SUBSCRIPTION_STATUSES.includes(
      tenant.subscription?.status ?? 'ACTIVE',
    )
  );
}

export type ActivationRequestResult = {
  ok: true;
  /** Ya había una solicitud hoy: no se volvió a avisar. */
  alreadyRequested: boolean;
  /** El negocio ya está activo: no hay nada que pedir. */
  nothingToDo: boolean;
};

/**
 * "Solicitar activación" desde el switch: el negocio está suspendido, cancelado o
 * vencido y la persona lo toca. SOLO AVISA al super-admin (alerta en la consola +
 * push, una por negocio y día); la activación la hace una persona desde la ficha,
 * después de validar el pago.
 */
@Injectable()
export class ActivationRequestService {
  private readonly logger = new Logger(ActivationRequestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly webPush: WebPushProvider,
  ) {}

  async requestActivation(
    user: AuthenticatedUser,
    tenantId: string,
  ): Promise<ActivationRequestResult> {
    if (!resolveTenantAccess(user, tenantId)) {
      throw new ForbiddenException('No tienes acceso a ese negocio.');
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: {
        id: true,
        name: true,
        status: true,
        subscription: { select: { status: true } },
        vertical: { select: { code: true } },
      },
    });
    if (!tenant) throw new NotFoundException('Negocio no encontrado');
    if (!isTenantLocked(tenant)) {
      return { ok: true, alreadyRequested: false, nothingToDo: true };
    }

    const name = tenant.name.trim();
    const service =
      VERTICAL_LABEL[tenant.vertical?.code ?? ''] ?? 'el servicio';
    const { created } = await recordPlatformAlert(
      this.prisma,
      this.webPush,
      this.logger,
      {
        type: ACTIVATION_REQUEST_ALERT,
        tenantId: tenant.id,
        title: `Piden activar ${name}`,
        body: `${user.name} (${user.email}) quiere usar ${service} en ${name}, que hoy no está activo. Valida el pago y actívalo desde la ficha.`,
        url: `/admin/tenants/${tenant.id}`,
      },
    );
    return { ok: true, alreadyRequested: !created, nothingToDo: false };
  }
}
