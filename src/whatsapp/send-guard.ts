import * as crypto from 'crypto';

/** Ventana más larga admitida en `tryConsume`; por encima, la limpieza la cortaría. */
export const MAX_RATE_WINDOW_MS = 3_600_000;

/**
 * Freno en memoria para los envíos de WhatsApp del negocio.
 *
 * Dos cosas, las dos pensadas para proteger el NÚMERO del negocio y no para
 * contabilidad:
 *
 * 1. Duplicados: el mismo aviso, al mismo destinatario y con el mismo texto,
 *    dentro de la ventana, sale una sola vez. Cubre el doble clic, el remount de
 *    React de la página de confirmación y el refresh del cliente. Mandar lo mismo
 *    dos veces seguidas es justo lo que hace que un cliente reporte spam.
 * 2. Tope por clave: cuántos envíos se permiten en la ventana. Lo usa el camino
 *    público, que no tiene usuario al que pedirle cuentas.
 *
 * Vive en memoria a propósito: hoy corre una sola instancia y esto es un
 * cortafuegos mientras llega el outbox persistente (fase 2 del plan
 * docs/WHATSAPP_CLOUD_MIGRATION_PLAN.md). Un reinicio lo vacía, y está bien.
 */
export class SendGuard {
  private readonly recentSends = new Map<string, number>();
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly dedupeWindowMs: number) {}

  /** `true` si este mismo mensaje ya salió dentro de la ventana. */
  isDuplicate(parts: string[]): boolean {
    this.prune();
    return this.recentSends.has(this.fingerprint(parts));
  }

  /** Registra un envío exitoso para que el siguiente idéntico se descarte. */
  rememberSent(parts: string[]): void {
    this.recentSends.set(this.fingerprint(parts), Date.now());
  }

  /**
   * Consume un cupo de `key`. Devuelve `false` si ya se agotaron los `max` de la
   * ventana; en ese caso no consume nada.
   */
  tryConsume(key: string, max: number, windowMs: number): boolean {
    this.prune();
    const now = Date.now();
    const recent = (this.hits.get(key) ?? []).filter((at) => now - at < windowMs);
    if (recent.length >= max) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }

  // Hash y no el texto: el mapa no tiene por qué guardar mensajes de clientes.
  private fingerprint(parts: string[]): string {
    return crypto.createHash('sha256').update(parts.join('\u0000')).digest('hex');
  }

  private prune(): void {
    const now = Date.now();
    for (const [key, at] of this.recentSends) {
      if (now - at >= this.dedupeWindowMs) this.recentSends.delete(key);
    }
    // Sin esto cada teléfono que alguna vez pasó por el tope dejaría su clave
    // viva para siempre.
    for (const [key, list] of this.hits) {
      const last = list[list.length - 1];
      if (last === undefined || now - last >= MAX_RATE_WINDOW_MS) {
        this.hits.delete(key);
      }
    }
  }
}
