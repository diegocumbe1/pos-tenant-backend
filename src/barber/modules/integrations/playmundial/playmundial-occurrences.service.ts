import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../../../prisma/prisma.service';
import { ensureRecurringHorizon } from '../../../shared/recurring-horizon';
import { PlayMundialAccess } from './playmundial-link.service';
import {
  parseWindow,
  PlayMundialOccurrence,
  toOccurrence,
} from './playmundial.helpers';

/** Tope de filas por consulta: la ventana máxima es de 8 días de dos canchas. */
const MAX_ROWS = 500;

@Injectable()
export class PlayMundialOccurrencesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Las reservas de la sede que tocan la ventana. Incluye canceladas y
   * no-shows A PROPÓSITO: Play Mundial necesita enterarse de que una reserva
   * ya no vale para anular su turno, no solo de las nuevas.
   *
   * Se completa el horizonte de las reservas fijas antes de leer: si nadie
   * abrió la agenda en semanas, la tablet igual vería el turno de hoy.
   *
   * Quedan fuera las asistencias a clases grupales (`classSessionId`): no son
   * una reserva de cancha.
   */
  async list(
    access: PlayMundialAccess,
    query: { from?: string; to?: string; courtId?: string },
  ): Promise<{
    window: { from: string; to: string };
    occurrences: PlayMundialOccurrence[];
  }> {
    const { from, to } = parseWindow(query.from, query.to);
    await ensureRecurringHorizon(this.prisma, access.branchId);

    const rows = await this.prisma.barberAppointment.findMany({
      where: {
        tenantId: access.tenantId,
        branchId: access.branchId,
        classSessionId: null,
        scheduledAt: { lt: to },
        scheduledEnd: { gt: from },
        ...(query.courtId ? { serviceId: query.courtId } : {}),
      },
      select: {
        id: true,
        updatedAt: true,
        branchId: true,
        serviceId: true,
        service: { select: { name: true } },
        scheduledAt: true,
        scheduledEnd: true,
        status: true,
        recurringBookingId: true,
        servedAt: true,
        customer: { select: { id: true, name: true } },
      },
      orderBy: { scheduledAt: 'asc' },
      take: MAX_ROWS,
    });

    return {
      window: { from: from.toISOString(), to: to.toISOString() },
      occurrences: rows.map(toOccurrence),
    };
  }
}
