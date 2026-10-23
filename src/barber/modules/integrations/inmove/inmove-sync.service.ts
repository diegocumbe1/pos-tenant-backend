import {
  BadGatewayException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { TenantContext } from '../../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../../shared/barber-tenant.helper';
import { InMoveExport, syncInMoveAthletes } from './inmove-sync';

/**
 * El botón "Sincronizar con In Move" de Ajustes.
 *
 * ES UNA EXCEPCIÓN POR TENANT. Solo lo ven los negocios listados en
 * `INMOVE_SYNC_TENANT_IDS` (separados por coma): el id no se escribe en el
 * código. La conexión es `INMOVE_API_URL` + `INMOVE_API_KEY`, la misma clave
 * que In Move tiene como `LYNKO_SYNC_KEY`.
 *
 * Lynko NUNCA lee la base de In Move: pide `GET /api/integrations/athletes`.
 */
@Injectable()
export class InMoveSyncService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  private isEnabledFor(tenantId: string): boolean {
    return (process.env.INMOVE_SYNC_TENANT_IDS ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean)
      .includes(tenantId);
  }

  status(ctx: TenantContext) {
    const enabled = this.isEnabledFor(ctx.tenantId);
    return {
      enabled,
      configured:
        enabled && !!process.env.INMOVE_API_URL && !!process.env.INMOVE_API_KEY,
    };
  }

  async sync(ctx: TenantContext, dryRun: boolean) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    if (!this.isEnabledFor(ctx.tenantId)) {
      throw new ForbiddenException(
        'La sincronización con In Move no está habilitada para este negocio',
      );
    }
    const baseUrl = process.env.INMOVE_API_URL;
    const key = process.env.INMOVE_API_KEY;
    if (!baseUrl || !key) {
      throw new ServiceUnavailableException(
        'Falta configurar INMOVE_API_URL e INMOVE_API_KEY',
      );
    }

    let payload: InMoveExport;
    try {
      const res = await fetch(
        `${baseUrl.replace(/\/$/, '')}/api/integrations/athletes`,
        {
          headers: { Authorization: `Bearer ${key}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!res.ok) {
        throw new Error(`In Move respondió ${res.status}`);
      }
      payload = (await res.json()) as InMoveExport;
    } catch (err) {
      throw new BadGatewayException(
        `No se pudo leer In Move: ${(err as Error).message}`,
      );
    }

    return syncInMoveAthletes(
      this.prisma,
      { tenantId: ctx.tenantId, branchId: ctx.branchId },
      payload,
      { commit: !dryRun, fichaBaseUrl: baseUrl },
    );
  }
}
