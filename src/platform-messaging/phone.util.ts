// TODO: leer countryCode desde configuración cuando operemos fuera de CO.
const DEFAULT_COUNTRY_CODE = '57';

/**
 * Deja el número en dígitos con indicativo; 10 dígitos = celular colombiano.
 * Vive aparte del canal de WhatsApp para que resolver a quién se le escribe no
 * dependa del adaptador que lo envía (ni de whatsapp-web.js).
 */
export function normalizePhone(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (!digits) throw new Error('El teléfono quedó vacío al normalizarlo');
  return digits.length <= 10 ? `${DEFAULT_COUNTRY_CODE}${digits}` : digits;
}
