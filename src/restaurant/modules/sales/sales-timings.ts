import { OrderEvent, OrderEventType } from '@prisma/client';

/** Coincide con `SaleTimings` del frontend (Anexo A §A3). */
export interface SaleTimings {
  openedAt: string | null;
  firstSentAt: string | null;
  firstServedAt: string | null;
  allServedAt: string | null;
  closedAt: string | null;
  timeToKitchenMs: number | null;
  timeToServeMs: number | null;
  dineDurationMs: number | null;
  totalDurationMs: number | null;
  sendsCount: number;
}

/**
 * Misma fórmula que el frontend (`services/sales-timings.ts`):
 * - timeToKitchenMs = firstSent − opened
 * - timeToServeMs   = (allServed ?? firstServed) − opened
 * - dineDurationMs  = closed − (allServed ?? firstServed)
 * - totalDurationMs = closed − opened
 * - sendsCount      = nº de SENT_TO_KITCHEN
 */
export function computeTimings(
  events: OrderEvent[],
  closedAtFallback?: Date | null,
): SaleTimings {
  const sorted = [...events].sort((a, b) => a.at.getTime() - b.at.getTime());
  const firstOf = (type: OrderEventType) =>
    sorted.find((e) => e.type === type)?.at ?? null;

  const opened = firstOf(OrderEventType.OPENED);
  const firstSent = firstOf(OrderEventType.SENT_TO_KITCHEN);
  const firstServed = firstOf(OrderEventType.SERVED);
  const allServed = firstOf(OrderEventType.ALL_SERVED);
  const served = allServed ?? firstServed;
  const closed = firstOf(OrderEventType.CLOSED) ?? closedAtFallback ?? null;

  const diff = (a: Date | null, b: Date | null) =>
    a && b ? a.getTime() - b.getTime() : null;
  const iso = (d: Date | null) => d?.toISOString() ?? null;

  return {
    openedAt: iso(opened),
    firstSentAt: iso(firstSent),
    firstServedAt: iso(firstServed),
    allServedAt: iso(allServed),
    closedAt: iso(closed),
    timeToKitchenMs: diff(firstSent, opened),
    timeToServeMs: diff(served, opened),
    dineDurationMs: diff(closed, served),
    totalDurationMs: diff(closed, opened),
    sendsCount: sorted.filter((e) => e.type === OrderEventType.SENT_TO_KITCHEN)
      .length,
  };
}
