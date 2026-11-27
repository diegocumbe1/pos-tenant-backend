import { Prisma } from '@prisma/client';

/**
 * LO QUE PAGÓ CADA CLIENTE, en SQL. Devuelve filas (`customerId`, `paid`).
 *
 * Misma regla que Finanzas → Ventas, el resumen de cobros y la cuenta del
 * cliente (BarberCustomerAccountService):
 *   1. pagos no anulados de cobros no anulados, por la fecha del PAGO;
 *   2. + citas completadas sin NINGÚN cobro (ni anulado), sin plan ni cobro
 *      agrupado que las cubra y que no son asistencia a clase (contado
 *      implícito), por la fecha del SERVICIO.
 *
 * Antes "Ha gastado" sumaba el precio de toda cita completada: un descuento, un
 * abono a medias o un cobro agrupado la descuadraban frente a Finanzas.
 *
 * Diferencia conocida: el contado implícito usa el precio guardado de la cita o
 * el del servicio, sin el cálculo por duración de canchas (`appointmentPriceCOP`).
 * Toda cita nueva guarda su precio, así que solo afecta a reservas viejas.
 */
export function customerPaidSql(
  tenantId: string,
  branchId: string,
  from?: Date,
  to?: Date,
  customerId?: string,
): Prisma.Sql {
  const paidAtWindow = Prisma.sql`
    ${from ? Prisma.sql`AND p."paidAt" >= ${from}` : Prisma.empty}
    ${to ? Prisma.sql`AND p."paidAt" <= ${to}` : Prisma.empty}
  `;
  const servedWindow = Prisma.sql`
    ${from ? Prisma.sql`AND COALESCE(a."servedAt", a."scheduledAt") >= ${from}` : Prisma.empty}
    ${to ? Prisma.sql`AND COALESCE(a."servedAt", a."scheduledAt") <= ${to}` : Prisma.empty}
  `;
  const onlyCharge = customerId
    ? Prisma.sql`AND c."customerId" = ${customerId}`
    : Prisma.sql`AND c."customerId" IS NOT NULL`;
  const onlyAppt = customerId
    ? Prisma.sql`AND a."customerId" = ${customerId}`
    : Prisma.sql`AND a."customerId" IS NOT NULL`;

  return Prisma.sql`
    SELECT u."customerId", SUM(u.amount)::int AS paid
    FROM (
      SELECT c."customerId", p."amountCOP" AS amount
      FROM "barber_payments" p
      JOIN "barber_charges" c ON c."id" = p."chargeId"
      WHERE p."tenantId" = ${tenantId}
        AND p."branchId" = ${branchId}
        AND p."voidedAt" IS NULL
        AND c."voidedAt" IS NULL
        ${onlyCharge}
        ${paidAtWindow}
      UNION ALL
      SELECT a."customerId", COALESCE(a."priceCOP", s."priceCOP") AS amount
      FROM "barber_appointments" a
      JOIN "barber_services" s ON s."id" = a."serviceId"
      WHERE a."tenantId" = ${tenantId}
        AND a."branchId" = ${branchId}
        AND LOWER(a."status") = 'completed'
        AND a."classSessionId" IS NULL
        AND a."coveredByChargeId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "barber_charges" x WHERE x."appointmentId" = a."id"
        )
        ${onlyAppt}
        ${servedWindow}
    ) u
    GROUP BY u."customerId"
  `;
}

/**
 * Lo pagado que no es de NINGÚN cliente en el periodo: cobros sin cliente y
 * citas completadas "sin cliente registrado". Se muestra para animar a
 * registrarlos (el ranking no los puede contar).
 */
export function unassignedPaidSql(
  tenantId: string,
  branchId: string,
  from?: Date,
  to?: Date,
): Prisma.Sql {
  return Prisma.sql`
    SELECT COALESCE(SUM(u.amount), 0)::int AS paid
    FROM (
      SELECT p."amountCOP" AS amount
      FROM "barber_payments" p
      JOIN "barber_charges" c ON c."id" = p."chargeId"
      WHERE p."tenantId" = ${tenantId}
        AND p."branchId" = ${branchId}
        AND p."voidedAt" IS NULL
        AND c."voidedAt" IS NULL
        AND c."customerId" IS NULL
        ${from ? Prisma.sql`AND p."paidAt" >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND p."paidAt" <= ${to}` : Prisma.empty}
      UNION ALL
      SELECT COALESCE(a."priceCOP", s."priceCOP") AS amount
      FROM "barber_appointments" a
      JOIN "barber_services" s ON s."id" = a."serviceId"
      WHERE a."tenantId" = ${tenantId}
        AND a."branchId" = ${branchId}
        AND LOWER(a."status") = 'completed'
        AND a."customerId" IS NULL
        AND a."classSessionId" IS NULL
        AND a."coveredByChargeId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "barber_charges" x WHERE x."appointmentId" = a."id"
        )
        ${from ? Prisma.sql`AND COALESCE(a."servedAt", a."scheduledAt") >= ${from}` : Prisma.empty}
        ${to ? Prisma.sql`AND COALESCE(a."servedAt", a."scheduledAt") <= ${to}` : Prisma.empty}
    ) u
  `;
}
