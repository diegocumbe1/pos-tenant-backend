import { addCalendarDaysCO, calendarDayCO } from '../../common/date.util';

export interface SpokenRange {
  /** Días calendario 'YYYY-MM-DD' en hora Colombia, ambos incluidos. */
  from: string;
  to: string;
  /** Se dice en la respuesta: el rango que se usó nunca queda implícito. */
  label: string;
}

const MONTHS = [
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'octubre',
  'noviembre',
  'diciembre',
];

const pad = (n: number) => String(n).padStart(2, '0');
const dayLabel = (day: string) => {
  const [, month, date] = day.split('-').map(Number);
  return `el ${date} de ${MONTHS[month - 1]}`;
};

/** Lunes de una semana ISO: la semana 1 es la que contiene el 4 de enero. */
function isoWeekMonday(year: number, week: number): string {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  monday.setUTCDate(monday.getUTCDate() + (week - 1) * 7);
  return monday.toISOString().slice(0, 10);
}

export function monthRange(
  year: number,
  month: number,
  today: string,
): SpokenRange {
  const first = `${year}-${pad(month)}-01`;
  const last = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return {
    from: first,
    to: last,
    label:
      today >= first && today <= last ? 'este mes' : `en ${MONTHS[month - 1]}`,
  };
}

/**
 * Lo que entrega `AMAZON.DATE`: día, semana (`2026-W45`, `2026-W45-WE`), mes o año.
 * Devuelve null con lo demás (temporadas, décadas): quien llama usa su rango por
 * defecto, y como la respuesta lo nombra, no se presenta como lo que se pidió.
 */
export function parseAlexaDate(
  value: string | undefined,
  now = new Date(),
): SpokenRange | null {
  if (!value) return null;
  const today = calendarDayCO(now);
  if (value === 'PRESENT_REF') return { from: today, to: today, label: 'hoy' };

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const label =
      value === today
        ? 'hoy'
        : value === addCalendarDaysCO(today, -1)
          ? 'ayer'
          : value === addCalendarDaysCO(today, 1)
            ? 'mañana'
            : dayLabel(value);
    return { from: value, to: value, label };
  }

  const week = /^(\d{4})-W(\d{2})(-WE)?$/.exec(value);
  if (week) {
    const monday = isoWeekMonday(Number(week[1]), Number(week[2]));
    if (week[3]) {
      return {
        from: addCalendarDaysCO(monday, 5),
        to: addCalendarDaysCO(monday, 6),
        label: `el fin de semana del ${dayLabel(addCalendarDaysCO(monday, 5)).slice(3)}`,
      };
    }
    const sunday = addCalendarDaysCO(monday, 6);
    return {
      from: monday,
      to: sunday,
      label:
        today >= monday && today <= sunday
          ? 'esta semana'
          : `la semana del ${dayLabel(monday).slice(3)}`,
    };
  }

  const month = /^(\d{4})-(\d{2})$/.exec(value);
  if (month) return monthRange(Number(month[1]), Number(month[2]), today);

  if (/^\d{4}$/.test(value)) {
    return {
      from: `${value}-01-01`,
      to: `${value}-12-31`,
      label: `en ${value}`,
    };
  }
  return null;
}

/** `AMAZON.DURATION` hacia atrás: P7D, P2W, P1M. Con lo demás, null. */
export function parseAlexaDuration(
  value: string | undefined,
  now = new Date(),
): SpokenRange | null {
  const match = value ? /^P(\d+)([DWM])$/.exec(value) : null;
  if (!match) return null;
  const amount = Number(match[1]);
  if (!amount) return null;
  const days = amount * { D: 1, W: 7, M: 30 }[match[2] as 'D' | 'W' | 'M'];
  const today = calendarDayCO(now);
  return {
    from: addCalendarDaysCO(today, -days),
    to: today,
    label: `en los últimos ${days} días`,
  };
}
