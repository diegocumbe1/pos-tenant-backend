import {
  AGENDA_REMINDER_TYPE,
  ruleFor,
  wantsNotification,
  type NotificationContext,
  type NotificationRule,
} from '../../../notifications/notification-rules';

export { ruleFor };

/**
 * Qué recordatorios tocan ahora, sin base de datos.
 *
 * Un recordatorio vale solo dentro de una ventana corta después de su hora: si el
 * servidor estuvo caído, o la cita se creó cuando ya había pasado, no sale un
 * "en 1 hora" a destiempo.
 */
export const REMINDER_GRACE_MS = 10 * 60 * 1000;

/** 4 semanas, y 5 avisos por cita: los mismos topes de Google Calendar. */
export const MAX_REMINDER_MINUTES = 4 * 7 * 24 * 60;
export const MAX_REMINDERS = 5;

export type ReminderScope = 'ALL' | 'MINE';

export interface ReminderRule extends NotificationRule {
  offsetsMinutes: number[];
}

export interface ReminderRecipient {
  id: string;
  roleCode: string;
  branchIds: string[];
}

export interface ReminderItem {
  /** `apt:<id>` o `class:<id>`. */
  key: string;
  branchId: string;
  scheduledAt: Date;
  /** Usuario de quien atiende. null = especialista sin usuario, o sin asignar. */
  staffUserId: string | null;
  /** De qué trata, para los filtros de cada persona. */
  context?: NotificationContext;
}

export interface DueReminder {
  itemKey: string;
  userId: string;
  minutesBefore: number;
  scheduledAt: Date;
}

function isDue(scheduledAt: Date, minutesBefore: number, now: Date) {
  const start = scheduledAt.getTime();
  const fireAt = start - minutesBefore * 60_000;
  const ms = now.getTime();
  if (ms < fireAt || ms >= fireAt + REMINDER_GRACE_MS) return false;
  // "En 5 minutos" no se manda con la cita ya empezada; "a la hora" sí.
  return minutesBefore === 0 || ms < start;
}

export function dueReminders(
  items: ReminderItem[],
  recipients: ReminderRecipient[],
  rules: ReminderRule[],
  now: Date,
): DueReminder[] {
  const due: DueReminder[] = [];
  for (const recipient of recipients) {
    const rule = ruleFor(recipient, rules);
    if (!rule?.offsetsMinutes.length) continue;
    for (const item of items) {
      // El dueño ve todas sus sedes; los demás, solo las que tienen asignadas.
      if (
        recipient.roleCode !== 'OWNER' &&
        !recipient.branchIds.includes(item.branchId)
      ) {
        continue;
      }
      const context = { ...item.context, staffUserId: item.staffUserId };
      if (
        !wantsNotification(recipient, rule, AGENDA_REMINDER_TYPE, context, true)
      ) {
        continue;
      }
      for (const minutesBefore of rule.offsetsMinutes) {
        if (!isDue(item.scheduledAt, minutesBefore, now)) continue;
        due.push({
          itemKey: item.key,
          userId: recipient.id,
          minutesBefore,
          scheduledAt: item.scheduledAt,
        });
      }
    }
  }
  return due;
}

/** "en 1 hora", "en 2 días", "ahora". */
export function offsetPhrase(minutes: number): string {
  if (minutes === 0) return 'ahora';
  const units: Array<[number, string, string]> = [
    [10080, 'semana', 'semanas'],
    [1440, 'día', 'días'],
    [60, 'hora', 'horas'],
  ];
  for (const [size, one, many] of units) {
    if (minutes % size === 0) {
      const count = minutes / size;
      return `en ${count} ${count === 1 ? one : many}`;
    }
  }
  return `en ${minutes} minuto${minutes === 1 ? '' : 's'}`;
}

/** Sin repetidos y en orden. Lanza si algo no se puede guardar. */
export function normalizeOffsets(offsets: number[]): number[] {
  const unique = [...new Set(offsets)].sort((a, b) => b - a);
  if (unique.length > MAX_REMINDERS) {
    throw new Error(`Máximo ${MAX_REMINDERS} avisos por cita`);
  }
  if (
    unique.some(
      (m) => !Number.isInteger(m) || m < 0 || m > MAX_REMINDER_MINUTES,
    )
  ) {
    throw new Error('Cada aviso debe ser de hasta 4 semanas antes');
  }
  return unique;
}
