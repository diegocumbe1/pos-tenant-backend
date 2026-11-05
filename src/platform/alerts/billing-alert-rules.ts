import {
  addCalendarDaysCO,
  calendarDayCO,
  dayStartCO,
  formatDateLongCO,
} from '../../common/date.util';
import { GRACE_DAYS } from '../platform.constants';

export const DUE_SOON_DAYS = 2;

export type BillingAlertType =
  | 'billing.due_soon'
  | 'billing.due'
  | 'billing.grace_ended';

export interface BillingDates {
  dueDay: string;
  graceDay: string;
}

interface SubscriptionDates {
  status: string;
  trialEndsAt: Date | null;
  nextPaymentDueAt: Date | null;
  currentPeriodEnd: Date;
  graceEndsAt: Date | null;
}

/**
 * El mismo vencimiento que muestra la consola. Las filas viejas tienen la gracia en
 * NULL o anterior al vencimiento (si se editó a mano): ahí valen `GRACE_DAYS`.
 */
export function billingDatesOf(sub: SubscriptionDates): BillingDates {
  const isTrial = sub.status === 'TRIALING' && !!sub.trialEndsAt;
  const due = isTrial
    ? (sub.trialEndsAt as Date)
    : (sub.nextPaymentDueAt ?? sub.currentPeriodEnd);
  const dueDay = calendarDayCO(due);
  const stored =
    !isTrial && sub.graceEndsAt ? calendarDayCO(sub.graceEndsAt) : null;
  return {
    dueDay,
    graceDay:
      stored && stored > dueDay
        ? stored
        : addCalendarDaysCO(dueDay, GRACE_DAYS),
  };
}

/**
 * Qué aviso toca hoy. Son ventanas y no días exactos: si el servidor estuvo caído el
 * día justo, el aviso sale apenas vuelva en vez de perderse.
 */
export function billingAlertFor(
  today: string,
  { dueDay, graceDay }: BillingDates,
): BillingAlertType | null {
  if (today >= graceDay) return 'billing.grace_ended';
  if (today >= dueDay) return 'billing.due';
  return today >= addCalendarDaysCO(dueDay, -DUE_SOON_DAYS)
    ? 'billing.due_soon'
    : null;
}

const daysBetween = (from: string, to: string) =>
  Math.round(
    (Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) /
      86_400_000,
  );

const plural = (n: number) => `${n} ${n === 1 ? 'día' : 'días'}`;

export function billingAlertText(
  type: BillingAlertType,
  tenantName: string,
  today: string,
  dueDay: string,
): { title: string; body: string } {
  const date = formatDateLongCO(dayStartCO(dueDay));
  const left = daysBetween(today, dueDay);
  const late = -left;
  switch (type) {
    case 'billing.due_soon':
      return {
        title: `${left === 1 ? 'Vence mañana' : `Vence en ${plural(left)}`}: ${tenantName}`,
        body: `Se vence el ${date}. Recuérdale el pago.`,
      };
    case 'billing.due':
      return late === 0
        ? {
            title: `Vence hoy: ${tenantName}`,
            body: 'Hoy es el vencimiento y aún no registra el pago.',
          }
        : {
            title: `Venció hace ${plural(late)}: ${tenantName}`,
            body: `Se venció el ${date} y aún no registra el pago.`,
          };
    case 'billing.grace_ended':
      return {
        title: `Revisar bloqueo: ${tenantName}`,
        body: `Lleva ${plural(late)} vencida sin pago. Decide si suspendes la cuenta; Lynko no la bloquea sola.`,
      };
  }
}

const GROUP_TITLE: Record<BillingAlertType, (n: number) => string> = {
  'billing.due_soon': (n) => `${n} cuentas por vencer`,
  'billing.due': (n) => `${n} cuentas vencidas sin pago`,
  'billing.grace_ended': (n) => `${n} cuentas para revisar bloqueo`,
};

/** Varias del mismo tipo salen en un solo push: el detalle queda en la consola. */
export function billingGroupText(
  type: BillingAlertType,
  names: string[],
): { title: string; body: string } {
  const shown = names.slice(0, 3).join(', ');
  const rest = names.length - 3;
  return {
    title: GROUP_TITLE[type](names.length),
    body: rest > 0 ? `${shown} y ${rest} más.` : `${shown}.`,
  };
}
