import { AssistantConfidence, AssistantOutcome, Prisma } from '@prisma/client';

export const INTENTS = new Set([
  'sales_summary',
  'low_stock',
  'out_of_stock',
  'inventory_value',
  'product_stock',
  'pending_payment',
  'pending_delivery',
  'business_summary',
  'business_report',
  'top_products',
  'worst_products',
  'top_customers',
  'catalog_overview',
  'catalog_category',
  'product_lookup',
  'list_businesses',
  'GetSubscriptionsIntent',
  'ActivarLynkoIntent',
  'CerrarAccesoIntent',
  'DespedidaIntent',
  'AMAZON.HelpIntent',
  'AMAZON.YesIntent',
  'AMAZON.NoIntent',
  'AMAZON.StopIntent',
  'AMAZON.CancelIntent',
  'fallback',
]);
const ROLES = new Set([
  'ROOT',
  'OWNER',
  'ADMIN',
  'MANAGER',
  'CASHIER',
  'WAITER',
  'KITCHEN',
  'ADMINISTRATIVE',
  'CHEF',
  'BARBER',
  'STAFF',
  'RECEPTIONIST',
]);
export function safeRole(value: string): string {
  return ROLES.has(value) ? value : 'OTHER';
}
export function safeIntent(value: unknown): string {
  return typeof value === 'string' && INTENTS.has(value) ? value : 'unknown';
}
export interface TelemetryContext {
  tenantId: string;
  branchId?: string | null;
  roleCode: string;
}
export interface TelemetryBatchDto {
  events?: unknown;
}
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/** Invalid enum values discard the event; arbitrary properties never reach Prisma. */
export function sanitizeEvent(
  value: unknown,
  ctx: TelemetryContext,
  channel: 'WEB' | 'ALEXA',
): Prisma.AssistantQueryLogCreateManyInput | null {
  const e = record(value);
  if (
    !e ||
    !['retail', 'restaurant', 'barber'].includes(String(e.vertical)) ||
    !Object.values(AssistantOutcome).includes(e.outcome as AssistantOutcome) ||
    !Object.values(AssistantConfidence).includes(
      e.confidence as AssistantConfidence,
    ) ||
    !['READ', 'PREPARE', 'EXECUTE'].includes(String(e.level))
  )
    return null;
  const resolvedTo = e.resolvedTo == null ? null : safeIntent(e.resolvedTo);
  if (
    resolvedTo !== null &&
    !['FALLBACK', 'CLARIFIED'].includes(String(e.outcome))
  )
    return null;
  return {
    tenantId: ctx.tenantId,
    branchId: ctx.branchId || null,
    role: safeRole(ctx.roleCode),
    channel,
    vertical: e.vertical as string,
    intentId: safeIntent(e.intentId),
    outcome: e.outcome as AssistantOutcome,
    confidence: e.confidence as AssistantConfidence,
    level: e.level as string,
    scope: ['today', 'week', 'month', 'custom'].includes(String(e.scope))
      ? (e.scope as string)
      : null,
    resolvedTo,
    latencyMs:
      resolvedTo !== null
        ? null
        : typeof e.latencyMs === 'number' && Number.isFinite(e.latencyMs)
          ? Math.max(0, Math.min(3600000, Math.round(e.latencyMs)))
          : null,
  };
}
