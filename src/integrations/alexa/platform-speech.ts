import { PlatformOverviewAnswer } from '../../assistant/assistant.types';

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

/** Dos frases como mucho: por voz, un listado largo no se retiene. */
export function overviewSpeech(answer: PlatformOverviewAnswer): string {
  const { subscriptions: subs, tenants } = answer;

  const detail = [
    subs.trialing ? `${subs.trialing} en prueba` : null,
    subs.pastDue ? `${subs.pastDue} en mora` : null,
  ].filter(Boolean);

  const first = `Tienes ${plural(subs.active, 'suscripción activa', 'suscripciones activas')}${
    detail.length ? `, ${detail.join(' y ')}` : ''
  }, sobre ${plural(tenants.total, 'negocio', 'negocios')} en total.`;

  return `${first} ${paymentsSpeech(answer)}`;
}

/**
 * Pagos cobrados, no MRR. El MRR suma el precio de lista de toda suscripción
 * activa, incluidas las que nunca pagaron —descuento del 100%, cortesías, el
 * tenant propio—, así que por voz suena a ingreso y no lo es. `amount` de
 * SubscriptionPayment es plata recibida neta, y los bonos quedan fuera por
 * `countsAsRevenue`. Sin separadores de miles: Alexa lee mejor el número crudo.
 */
export function paymentsSpeech(answer: PlatformOverviewAnswer): string {
  const { count, totalCOP } = answer.payments;
  return count
    ? `Este mes has recibido ${plural(count, 'pago', 'pagos')} por ${totalCOP} pesos.`
    : 'Este mes todavía no has recibido pagos.';
}
