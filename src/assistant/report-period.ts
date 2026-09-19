import { ReportPeriod } from './assistant.types';

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
 */
export function periodRange(
  period: ReportPeriod,
  now = new Date(),
): { from: Date; to: Date } {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);

  if (period === 'week') {
    // getDay(): 0 es domingo. La semana laboral local empieza el lunes.
    const daysSinceMonday = (from.getDay() + 6) % 7;
    from.setDate(from.getDate() - daysSinceMonday);
  } else if (period === 'month') {
    from.setDate(1);
  }

  return { from, to: now };
}

/** Lo que se dice en voz alta, para que nadie confunda el rango consultado. */
export function periodLabel(period: ReportPeriod): string {
  switch (period) {
    case 'week':
      return 'en lo que va de la semana';
    case 'month':
      return 'en lo que va del mes';
    default:
      return 'hoy';
  }
}

/** Del slot hablado al período. Sin slot, el reporte es del día. */
export function parsePeriod(spoken: string | undefined): ReportPeriod {
  const said = (spoken ?? '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
  if (said.includes('semana')) return 'week';
  if (said.includes('mes')) return 'month';
  return 'day';
}
