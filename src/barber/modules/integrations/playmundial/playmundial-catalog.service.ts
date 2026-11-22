import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { PlayMundialAccess } from './playmundial-link.service';
import {
  CustomerSummary,
  parseSummaryRange,
  summarizeByCustomer,
} from './playmundial.helpers';

/** Tope de reservas leídas para un resumen: un trimestre de varias canchas. */
const MAX_SUMMARY_ROWS = 20_000;

@Injectable()
export class PlayMundialCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Las canchas de la sede: los servicios activos que se reservan por horario
   * (no planes, paquetes ni clases). Aunque no tengan reservas todavía, para que
   * Play Mundial pueda traerlas todas de una vez.
   */
  async courts(access: PlayMundialAccess) {
    const rows = await this.prisma.barberService.findMany({
      where: {
        tenantId: access.tenantId,
        branchId: access.branchId,
        isActive: true,
        kind: 'SERVICE',
      },
      select: { id: true, name: true, durationMin: true, sortOrder: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return {
      courts: rows.map((r) => ({
        id: r.id,
        name: r.name,
        durationMin: r.durationMin,
      })),
    };
  }

  /**
   * Cuántas veces contrató cada cliente en un rango (para el cierre de mes).
   * La fecha que manda es `servedAt` (cuándo se prestó); si no la tiene, la hora
   * agendada. Sin teléfono ni precios: solo id y nombre.
   */
  async customersSummary(
    access: PlayMundialAccess,
    query: { from?: string; to?: string },
  ): Promise<{
    window: { from: string; to: string };
    customers: CustomerSummary[];
  }> {
    const { from, to } = parseSummaryRange(query.from, query.to);
    const rows = await this.prisma.barberAppointment.findMany({
      where: {
        tenantId: access.tenantId,
        branchId: access.branchId,
        classSessionId: null,
        customerId: { not: null },
        OR: [
          { servedAt: { gte: from, lt: to } },
          { servedAt: null, scheduledAt: { gte: from, lt: to } },
        ],
      },
      select: {
        status: true,
        scheduledAt: true,
        scheduledEnd: true,
        servedAt: true,
        customer: { select: { id: true, name: true } },
      },
      take: MAX_SUMMARY_ROWS,
    });
    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      customers: summarizeByCustomer(rows),
    };
  }
}
