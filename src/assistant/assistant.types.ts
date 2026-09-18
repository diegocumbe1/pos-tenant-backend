/**
 * Respuestas del asistente: cifras, nunca texto redactado.
 *
 * Cada canal (Alexa por voz, chat web en pantalla) las formatea a su manera.
 * Ver docs/ALEXA_VOICE_ACTIVATION.md §"Plan siguiente".
 */

export interface PendingPaymentAnswer {
  business: { id: string; name: string };
  totalCOP: number;
  salesCount: number;
  /** De mayor a menor saldo. Vacío no significa cero deuda: ver `unidentified`. */
  customers: { name: string; amountCOP: number; salesCount: number }[];
  /** Ventas de mostrador sin cliente asociado: deuda sin a quién llamar. */
  unidentified: { amountCOP: number; salesCount: number };
}

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
