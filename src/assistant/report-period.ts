import { ReportPeriod } from './assistant.types';

/** Meses en español, sin tildes, en el orden de `Date.getMonth()`. */
const MONTH_NAMES = [
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

/** "setiembre" y "setiembre" conviven en Colombia; ambas deben resolver. */
const MONTH_ALIASES: Record<string, number> = {
  setiembre: 8,
};

const startOfDay = (d: Date): Date => {
  const copy = new Date(d);
  copy.setHours(0, 0, 0, 0);
  return copy;
};

/** `last:15` → 15. Null si no es un período de N días. */
export function lastDaysOf(period: ReportPeriod): number | null {
  const match = /^last:(\d{1,4})$/.exec(period);
  if (!match) return null;
  const days = Number(match[1]);
  return days > 0 ? days : null;
}

/** `month:2026-03` → { year, monthIndex }. Null si no es un mes concreto. */
export function monthOf(
  period: ReportPeriod,
): { year: number; monthIndex: number } | null {
  const match = /^month:(\d{4})-(\d{2})$/.exec(period);
  if (!match) return null;
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  if (monthIndex < 0 || monthIndex > 11) return null;
  return { year, monthIndex };
}

/**
 * Rango del período, en hora local.
 *
 * El proceso corre con `TZ=America/Bogota`, así que "hoy" empieza a medianoche
 * en Bogotá y no en UTC: sin eso, a partir de las 7 de la tarde el reporte del
 * día mostraría las ventas de mañana.
 *
 * `week` es la semana corrida desde el lunes, no los últimos siete días, y
 * `month` va desde el día 1. Es lo que entiende quien pregunta "cómo vamos este
 * mes", y por eso la respuesta hablada dice "en lo que va del mes".
 *
 * Los períodos CERRADOS —`yesterday`, `lastWeek`, `lastMonth`, un mes ya
 * pasado— van de medianoche a medianoche, no hasta `now`. Comparar un período
 * completo contra "lo que va de hoy" es lo que hace que ayer siempre parezca
 * mejor.
 */
export function periodRange(
  period: ReportPeriod,
  now = new Date(),
): { from: Date; to: Date } {
  const today = startOfDay(now);

  // "Los últimos N días" INCLUYE hoy: quien pregunta por los últimos 7 cuenta
  // el de hoy como uno de ellos. Por eso se restan N-1 y no N.
  const days = lastDaysOf(period);
  if (days !== null) {
    const from = new Date(today);
    from.setDate(from.getDate() - (days - 1));
    return { from, to: now };
  }

  const month = monthOf(period);
  if (month) {
    const from = new Date(today);
    from.setFullYear(month.year, month.monthIndex, 1);
    const to = new Date(from);
    to.setMonth(to.getMonth() + 1);
    // El mes en curso se corta AHORA: decir "en marzo vendiste X" con el mes a
    // medias y el rango hasta el día 31 sugiere un cierre que todavía no pasó.
    return { from, to: to > now ? now : to };
  }

  switch (period) {
    case 'yesterday': {
      // La medianoche de hoy es el cierre de ayer.
      const from = new Date(today);
      from.setDate(from.getDate() - 1);
      return { from, to: today };
    }
    case 'week': {
      // getDay(): 0 es domingo. La semana laboral local empieza el lunes.
      const from = new Date(today);
      from.setDate(from.getDate() - ((from.getDay() + 6) % 7));
      return { from, to: now };
    }
    case 'lastWeek': {
      const to = new Date(today);
      to.setDate(to.getDate() - ((to.getDay() + 6) % 7));
      const from = new Date(to);
      from.setDate(from.getDate() - 7);
      return { from, to };
    }
    case 'month': {
      const from = new Date(today);
      from.setDate(1);
      return { from, to: now };
    }
    case 'lastMonth': {
      const to = new Date(today);
      to.setDate(1);
      const from = new Date(to);
      from.setMonth(from.getMonth() - 1);
      return { from, to };
    }
    case 'year': {
      const from = new Date(today);
      from.setMonth(0, 1);
      return { from, to: now };
    }
    default:
      return { from: today, to: now };
  }
}

/** Lo que se dice en voz alta, para que nadie confunda el rango consultado. */
export function periodLabel(period: ReportPeriod): string {
  const days = lastDaysOf(period);
  if (days !== null) {
    return days === 1 ? 'hoy' : `en los últimos ${days} días`;
  }

  const month = monthOf(period);
  if (month) {
    const name = MONTH_NAMES[month.monthIndex];
    const thisYear = new Date().getFullYear();
    // El año solo se nombra cuando NO es el actual: "en marzo" se lee mejor que
    // "en marzo de 2026" cuando es obvio de qué año se habla.
    return month.year === thisYear
      ? `en ${name}`
      : `en ${name} de ${month.year}`;
  }

  switch (period) {
    case 'yesterday':
      return 'ayer';
    case 'week':
      return 'en lo que va de la semana';
    case 'lastWeek':
      return 'la semana pasada';
    case 'month':
      return 'en lo que va del mes';
    case 'lastMonth':
      return 'el mes pasado';
    case 'year':
      return 'en lo que va del año';
    default:
      return 'hoy';
  }
}

const strip = (value: string): string =>
  value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

/** Números escritos con letra, que es como se dicen por voz. */
const SPELLED: Record<string, number> = {
  un: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  once: 11,
  doce: 12,
  quince: 15,
  veinte: 20,
  treinta: 30,
  sesenta: 60,
  noventa: 90,
};

/**
 * El período que menciona un texto libre, o null si no menciona ninguno.
 *
 * Devolver null y no un default es lo importante: quien lo llama decide qué
 * asumir, y —sobre todo— puede DECIRLO en la respuesta. Asumir "hoy" en
 * silencio ante "ventas de los últimos 7 días" es dar una cifra correcta a una
 * pregunta que nadie hizo.
 *
 * El orden va de más específico a menos: "el mes pasado" se resuelve antes de
 * que "mes" pueda reclamarlo.
 */
export function parsePeriodText(text: string): ReportPeriod | null {
  const said = strip(text);
  if (!said) return null;

  // ── Últimos N días / semanas / meses ──────────────────────────────────────
  const window =
    /\b(?:ultim[oa]s?|pasad[oa]s?)\s+(\d{1,4}|[a-z]+)\s+(dias?|semanas?|meses|mes)\b/.exec(
      said,
    );
  if (window) {
    const raw = window[1];
    const count = /^\d+$/.test(raw) ? Number(raw) : (SPELLED[raw] ?? 0);
    if (count > 0) {
      const unit = window[2];
      const days = unit.startsWith('semana')
        ? count * 7
        : unit.startsWith('mes')
          ? count * 30
          : count;
      // Un tope defensivo: "los últimos 9999 días" es ruido, no una pregunta.
      if (days >= 1 && days <= 1825) return `last:${days}`;
    }
  }

  // ── Un mes por su nombre ──────────────────────────────────────────────────
  // Se mira antes que `mes` suelto: "en marzo" no es "este mes".
  for (const [index, name] of MONTH_NAMES.entries()) {
    if (new RegExp(`\\b${name}\\b`).test(said)) {
      return monthPeriod(index, said);
    }
  }
  for (const [alias, index] of Object.entries(MONTH_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(said)) {
      return monthPeriod(index, said);
    }
  }

  // ── Ventanas con nombre ───────────────────────────────────────────────────
  if (/\b(mes pasado|mes anterior|el mes que paso)\b/.test(said)) {
    return 'lastMonth';
  }
  if (/\b(semana pasada|semana anterior)\b/.test(said)) return 'lastWeek';
  // `\bayer\b` y no `includes('ayer')`: "anteayer" es otra pregunta, y
  // responderla con las cifras de ayer sería equivocarse en silencio.
  if (/\bayer\b/.test(said)) return 'yesterday';
  // `dia` y `ano` sueltos entran porque son los valores CANÓNICOS del slot
  // REPORT_PERIOD de Alexa: cuando el modelo resuelve "de hoy", lo que llega es
  // "día". En texto libre son raros, y van después de las ventanas específicas
  // —"últimos 15 días" ya se resolvió arriba— para no robárselas.
  if (/\b(hoy|dia|del dia|de la jornada|diario)\b/.test(said)) return 'day';
  if (/\b(ano|este ano|del ano|anual|en el ano)\b/.test(said)) return 'year';
  if (/\bsemanas?\b/.test(said) || /\bsemanal\b/.test(said)) return 'week';
  if (/\b(mes|meses|mensual)\b/.test(said)) return 'month';

  return null;
}

/** El mes nombrado, con el año que diga el texto o el más reciente ya vivido. */
function monthPeriod(monthIndex: number, said: string): ReportPeriod {
  const now = new Date();
  const explicit = /\b(20\d{2})\b/.exec(said);
  const year = explicit
    ? Number(explicit[1])
    : // Sin año, se asume el más reciente que ya ocurrió: en enero, "en
      // diciembre" es el diciembre pasado y no el que falta once meses.
      monthIndex > now.getMonth()
      ? now.getFullYear() - 1
      : now.getFullYear();
  return `month:${year}-${String(monthIndex + 1).padStart(2, '0')}`;
}

/**
 * Del slot hablado al período. Sin slot, el reporte es del día.
 *
 * Es el contrato que espera Alexa: el slot `periodo` siempre trae algo o nada,
 * y nunca debe dejar la consulta sin ventana.
 */
export function parsePeriod(spoken: string | undefined): ReportPeriod {
  return parsePeriodText(spoken ?? '') ?? 'day';
}
