import { Prisma } from '@prisma/client';

export const DAY_OF_WEEK_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

export type DayOfWeek = (typeof DAY_OF_WEEK_ORDER)[number];
export type TimeRange = { start: string; end: string };
export type BusinessHours = Record<DayOfWeek, TimeRange[]>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Horario por defecto cuando el negocio aún no configuró nada (L–V 8–12/14–18,
// Sáb 8–12, Dom cerrado). Coincide con el default del frontend.
export const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  monday: [
    { start: '08:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  tuesday: [
    { start: '08:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  wednesday: [
    { start: '08:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  thursday: [
    { start: '08:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  friday: [
    { start: '08:00', end: '12:00' },
    { start: '14:00', end: '18:00' },
  ],
  saturday: [{ start: '08:00', end: '12:00' }],
  sunday: [],
};

export const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

export function sanitizeBusinessHours(
  raw: Record<string, unknown>,
): BusinessHours {
  return DAY_OF_WEEK_ORDER.reduce((acc, day) => {
    const ranges = Array.isArray(raw?.[day]) ? (raw[day] as unknown[]) : [];
    acc[day] = ranges
      .filter(
        (r): r is TimeRange =>
          !!r &&
          typeof r === 'object' &&
          typeof (r as TimeRange).start === 'string' &&
          typeof (r as TimeRange).end === 'string' &&
          HHMM.test((r as TimeRange).start) &&
          HHMM.test((r as TimeRange).end) &&
          hhmmToMinutes((r as TimeRange).end) >
            hhmmToMinutes((r as TimeRange).start),
      )
      .map((r) => ({ start: r.start, end: r.end }))
      .sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
    return acc;
  }, {} as BusinessHours);
}

// Lo que persistimos puede ser {} (default de columna). En ese caso devolvemos
// el horario por defecto: el admin y el sitio público deben ver el mismo
// horario, o la agenda muestra turnos que la reserva pública da por cerrados.
export function resolveBusinessHours(raw: Prisma.JsonValue): BusinessHours {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return DEFAULT_BUSINESS_HOURS;
  }
  const hasAnyDay = DAY_OF_WEEK_ORDER.some((day) =>
    Array.isArray((raw as Record<string, unknown>)[day]),
  );
  if (!hasAnyDay) return DEFAULT_BUSINESS_HOURS;
  return sanitizeBusinessHours(raw as Record<string, unknown>);
}
