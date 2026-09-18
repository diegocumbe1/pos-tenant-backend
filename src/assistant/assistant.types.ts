/**
 * Respuestas del asistente: cifras, nunca texto redactado.
 *
 * Cada canal (Alexa por voz, chat web en pantalla) las formatea a su manera.
 * Ver docs/ALEXA_VOICE_ACTIVATION.md §"Plan siguiente".
 */

export interface PlatformOverviewAnswer {
  tenants: { total: number; active: number; suspended: number };
  subscriptions: {
    active: number;
    trialing: number;
    pastDue: number;
    /** Activas + en prueba + en mora: las que hoy generan o van a generar ingreso. */
    billable: number;
  };
  mrrCOP: number;
  payments: { month: string; count: number; totalCOP: number };
}
