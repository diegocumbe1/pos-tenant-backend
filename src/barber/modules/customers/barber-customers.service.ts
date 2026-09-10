import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { dayEndCO, dayStartCO } from '../../../common/date.util';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberCustomerDto,
  UpdateBarberCustomerDto,
} from './dto/barber-customer.dto';
import {
  BarberCustomerSegmentQueryDto,
  BarberCustomerSegmentResult,
  BarberCustomerSegmentRow,
} from './dto/barber-customer-segment.dto';

/** Lo que devuelve el SQL crudo, antes de darle forma de DTO. */
interface SegmentSqlRow {
  id: string;
  name: string;
  phone: string;
  email: string | null;
  tags: string[];
  totalVisits: number;
  last_served_at: Date | null;
  last_service_id: string | null;
  last_service_name: string | null;
  retouch_price_cop: number | null;
  total_spent_cop: number;
  days_since: number | null;
  due_kind: 'retouch' | 'maintenance' | null;
}

@Injectable()
export class BarberCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async listCustomers(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberCustomer.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: [{ name: 'asc' }],
    });
  }

  /**
   * La lista "por atender": a quién hay que llamar y por qué.
   *
   * POR QUÉ UN ENDPOINT APARTE Y NO FILTROS EN EL LISTADO. La pregunta no es
   * "dame los clientes"; es "dame el último servicio de cada uno, cuántos días
   * lleva, cuánto vale su retoque y cuánto ha gastado". Eso es una agregación
   * por cliente, no un filtro sobre una tabla.
   *
   * POR QUÉ SQL CRUDO. Hace falta el último servicio POR CLIENTE (una función de
   * ventana), comparar cada fecha contra los días configurados de SU servicio, y
   * paginar sobre el resultado ya filtrado. Resolverlo en JS obligaría a traer
   * todas las citas del negocio y a paginar después de filtrar, que es
   * exactamente lo que hoy hace mal la ficha del cliente.
   *
   * SOLO CUENTAN LOS SERVICIOS REALIZADOS, y con su precio congelado: una cita
   * cancelada no es una visita, y el precio de hoy no es lo que se cobró.
   */
  async listSegments(
    ctx: TenantContext,
    query: BarberCustomerSegmentQueryDto,
  ): Promise<BarberCustomerSegmentResult> {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);

    const limit = query.limit ?? 50;
    const offset = query.offset ?? 0;

    // `status` es String libre y conviven 'completed'/'COMPLETED'/'Completed'
    // en la base, así que se compara en minúsculas — mismo criterio que
    // `isCompletedStatus()`.
    const base = Prisma.sql`
      WITH completed AS (
        SELECT
          a."customerId",
          a."serviceId",
          a."servedAt",
          COALESCE(a."priceCOP", s."priceCOP") AS price,
          s."name"                 AS service_name,
          s."retouchPriceCOP"      AS retouch_price_cop,
          s."retouchAfterDays"     AS retouch_after_days,
          s."maintenanceAfterDays" AS maintenance_after_days,
          ROW_NUMBER() OVER (
            PARTITION BY a."customerId" ORDER BY a."servedAt" DESC
          ) AS rn
        FROM "barber_appointments" a
        JOIN "barber_services" s ON s."id" = a."serviceId"
        WHERE a."tenantId" = ${ctx.tenantId}
          AND a."branchId" = ${ctx.branchId}
          AND LOWER(a."status") = 'completed'
          AND a."servedAt" IS NOT NULL
      ),
      totals AS (
        SELECT "customerId", SUM(price)::int AS total_spent
        FROM completed GROUP BY "customerId"
      ),
      last_visit AS (
        SELECT * FROM completed WHERE rn = 1
      ),
      rows AS (
        SELECT
          c."id",
          c."name",
          c."phone",
          c."email",
          c."tags",
          c."totalVisits",
          l."servedAt"          AS last_served_at,
          l."serviceId"         AS last_service_id,
          l.service_name        AS last_service_name,
          l.retouch_price_cop,
          COALESCE(t.total_spent, 0)::int AS total_spent_cop,
          CASE WHEN l."servedAt" IS NULL THEN NULL ELSE
            (
              (NOW() AT TIME ZONE 'America/Bogota')::date
              - (l."servedAt" AT TIME ZONE 'America/Bogota')::date
            )
          END AS days_since,
          -- El mantenimiento manda sobre el retoque cuando los dos están
          -- vencidos: es la venta más grande y la que lleva más tiempo esperando.
          CASE
            WHEN l.maintenance_after_days IS NOT NULL
             AND l."servedAt" + (l.maintenance_after_days || ' days')::interval <= NOW()
              THEN 'maintenance'
            WHEN l.retouch_after_days IS NOT NULL
             AND l."servedAt" + (l.retouch_after_days || ' days')::interval <= NOW()
              THEN 'retouch'
            ELSE NULL
          END AS due_kind
        FROM "barber_customers" c
        LEFT JOIN last_visit l ON l."customerId" = c."id"
        LEFT JOIN totals     t ON t."customerId" = c."id"
        WHERE c."tenantId" = ${ctx.tenantId}
          AND c."branchId" = ${ctx.branchId}
          AND c."isActive" = true
          ${
            query.serviceIds?.length
              ? Prisma.sql`AND EXISTS (
                  SELECT 1 FROM completed cc
                   WHERE cc."customerId" = c."id"
                     AND cc."serviceId" IN (${Prisma.join(query.serviceIds)})
                )`
              : Prisma.empty
          }
          ${
            query.servedBefore
              ? Prisma.sql`AND l."servedAt" < ${dayStartCO(query.servedBefore)}`
              : Prisma.empty
          }
          ${
            query.servedAfter
              ? Prisma.sql`AND l."servedAt" > ${dayEndCO(query.servedAfter)}`
              : Prisma.empty
          }
          ${
            query.minVisits !== undefined
              ? Prisma.sql`AND c."totalVisits" >= ${query.minVisits}`
              : Prisma.empty
          }
          ${
            query.maxVisits !== undefined
              ? Prisma.sql`AND c."totalVisits" <= ${query.maxVisits}`
              : Prisma.empty
          }
          ${
            query.tags?.length
              ? Prisma.sql`AND c."tags" && ${query.tags}::text[]`
              : Prisma.empty
          }
          ${
            query.search
              ? Prisma.sql`AND (c."name" ILIKE ${`%${query.search}%`} OR c."phone" ILIKE ${`%${query.search}%`})`
              : Prisma.empty
          }
      )
      SELECT * FROM rows
      ${
        query.dueOnly
          ? Prisma.sql`WHERE due_kind = ${query.dueOnly}`
          : Prisma.empty
      }
    `;

    const [rows, summary] = await Promise.all([
      this.prisma.$queryRaw<SegmentSqlRow[]>`
        ${base}
        -- Primero el que lleva más tiempo sin volver: es a quien hay que llamar.
        -- Los que nunca han venido van al final, no al principio.
        ORDER BY last_served_at ASC NULLS LAST, "name" ASC
        LIMIT ${limit} OFFSET ${offset}
      `,
      this.prisma.$queryRaw<{ total: bigint; pending: number | null }[]>`
        SELECT
          COUNT(*) AS total,
          -- Lo que vale la lista COMPLETA, no la página: es el número que
          -- convierte "12 personas" en "12 personas · $2.160.000".
          SUM(CASE WHEN due_kind IS NOT NULL THEN retouch_price_cop ELSE 0 END)::int AS pending
        FROM (${base}) s
      `,
    ]);

    return {
      rows: rows.map(
        (r): BarberCustomerSegmentRow => ({
          id: r.id,
          name: r.name,
          phone: r.phone,
          email: r.email,
          tags: r.tags,
          totalVisits: r.totalVisits,
          lastServedAt: r.last_served_at,
          lastServiceId: r.last_service_id,
          lastServiceName: r.last_service_name,
          daysSinceLastVisit: r.days_since,
          retouchPriceCOP: r.retouch_price_cop,
          totalSpentCOP: r.total_spent_cop,
          dueKind: r.due_kind,
        }),
      ),
      total: Number(summary[0]?.total ?? 0),
      pendingRetouchCOP: summary[0]?.pending ?? 0,
    };
  }

  async createCustomer(ctx: TenantContext, dto: CreateBarberCustomerDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberCustomer.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        notes: dto.notes,
        tags: dto.tags ?? [],
      },
    });
  }

  async updateCustomer(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberCustomerDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      id,
      'Customer',
    );
    return this.prisma.barberCustomer.update({
      where: { id },
      data: dto,
    });
  }

  // Borrado en cascada (control del OWNER): elimina el cliente y TODAS sus citas,
  // para que no quede historial falso ni cuente en agenda ni finanzas.
  async deleteCustomer(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      id,
      'Customer',
    );
    await this.prisma.$transaction([
      this.prisma.barberAppointment.deleteMany({
        where: { tenantId: ctx.tenantId, customerId: id },
      }),
      this.prisma.barberCustomer.delete({ where: { id } }),
    ]);
    return { ok: true };
  }
}
