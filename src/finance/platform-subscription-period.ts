import { calendarMonthCO } from '../common/date.util';

/** Origen de los gastos y plantillas sembrados desde la suscripción a Lynko. */
export const PLATFORM_SUBSCRIPTION_SOURCE = 'PLATFORM_SUBSCRIPTION';

/**
 * A qué periodo de cobro pertenece un gasto de Lynko: el mes ('YYYY-MM') o,
 * en planes anuales, el año ('YYYY').
 *
 * POR QUÉ EXISTE. El dueño puede registrar el cobro de Lynko por dos caminos:
 * el botón "Registrar" sobre un pago real de la plataforma, o "Pagar" sobre la
 * fecha del gasto recurrente. Si usa los dos para el mismo mes, el gasto
 * quedaría duplicado. Los dos caminos preguntan por esta llave: si ya hay un
 * gasto de Lynko en ese periodo, se enlaza al existente en vez de crear otro.
 */
export function platformPeriodKey(
  value: Date | string,
  annual: boolean,
): string {
  const month =
    typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
      ? value.slice(0, 7)
      : calendarMonthCO(value);
  return annual ? month.slice(0, 4) : month;
}
