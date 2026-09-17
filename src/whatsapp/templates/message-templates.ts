/**
 * Plantillas de WhatsApp del tenant: catálogo de claves, textos por defecto y
 * render por tokens.
 *
 * Antes cada mensaje se armaba concatenando strings en TypeScript, así que lo
 * que el dueño escribía en Ajustes no tenía forma de llegar al envío. Ahora el
 * default vive aquí, el texto editado vive en `whatsapp_templates`, y el envío
 * renderiza el que corresponda. La UI lee estos mismos defaults por API, de modo
 * que lo que se ve en pantalla es literalmente lo que se manda.
 *
 * El token es `{variable}` (llave simple), no `{{variable}}`: las plantillas de
 * plataforma (backoffice → dueños) son otro sistema, con otra tabla y otro
 * público. No se comparten.
 */

export const WHATSAPP_TEMPLATE_KEYS = [
  'APPOINTMENT_BUSINESS',
  'APPOINTMENT_CUSTOMER',
  'ORDER_BUSINESS',
  'ORDER_CUSTOMER',
] as const;

export type WhatsappTemplateKey = (typeof WHATSAPP_TEMPLATE_KEYS)[number];

export function isWhatsappTemplateKey(
  value: string,
): value is WhatsappTemplateKey {
  return (WHATSAPP_TEMPLATE_KEYS as readonly string[]).includes(value);
}

export interface WhatsappTemplateDefinition {
  key: WhatsappTemplateKey;
  /** Nombre legible, para la consola y los logs. */
  name: string;
  /** Vertical a la que aplica, según lo que el negocio agenda o vende. */
  scope: 'agenda' | 'catalog';
  /** A quién va dirigido el mensaje. */
  audience: 'business' | 'customer';
  /** Tope de caracteres que acepta el editor. */
  limit: number;
  /** Tokens que el mensaje necesita para ser útil. Se avisan, no se imponen. */
  required: string[];
  /** Todos los tokens que este mensaje sabe llenar. */
  variables: string[];
  body: string;
}

const AGENDA_VARIABLES = [
  '{negocio}',
  '{cliente}',
  '{telefono}',
  '{servicio}',
  '{fecha}',
  '{hora}',
  '{especialista}',
];

const CATALOG_VARIABLES = [
  '{negocio}',
  '{cliente}',
  '{telefono}',
  '{pedido}',
  '{productos}',
  '{total}',
  '{fecha}',
  '{entrega}',
];

export const WHATSAPP_TEMPLATE_DEFINITIONS: Record<
  WhatsappTemplateKey,
  WhatsappTemplateDefinition
> = {
  APPOINTMENT_BUSINESS: {
    key: 'APPOINTMENT_BUSINESS',
    name: 'Nueva cita — aviso al negocio',
    scope: 'agenda',
    audience: 'business',
    limit: 420,
    required: ['{cliente}', '{telefono}', '{servicio}', '{fecha}', '{hora}'],
    variables: AGENDA_VARIABLES,
    body: [
      'Nueva cita agendada en {negocio}:',
      '',
      '👤 Cliente: {cliente} ({telefono})',
      '✂️ Servicio: {servicio}',
      '📅 {fecha} a las {hora}',
      '👤 Especialista: {especialista}',
    ].join('\n'),
  },
  APPOINTMENT_CUSTOMER: {
    key: 'APPOINTMENT_CUSTOMER',
    name: 'Recordatorio de cita — mensaje al cliente',
    scope: 'agenda',
    audience: 'customer',
    limit: 500,
    required: ['{negocio}', '{cliente}', '{servicio}', '{fecha}', '{hora}'],
    variables: AGENDA_VARIABLES,
    body: [
      'Hola {cliente}, te recordamos tu cita en {negocio}:',
      '',
      '📅 Fecha: {fecha}',
      '⏰ Hora: {hora}',
      '✂️ Servicio: {servicio}',
      '👤 Especialista: {especialista}',
      '',
      'Nos vemos pronto. 🙌',
    ].join('\n'),
  },
  ORDER_BUSINESS: {
    key: 'ORDER_BUSINESS',
    name: 'Nuevo pedido — aviso al negocio',
    scope: 'catalog',
    audience: 'business',
    // Más holgado que en agenda: {productos} es una lista, no un dato suelto.
    limit: 600,
    required: ['{cliente}', '{telefono}', '{productos}', '{total}'],
    variables: CATALOG_VARIABLES,
    body: [
      'Nuevo pedido en {negocio}:',
      '',
      '🧾 Pedido: {pedido}',
      '👤 Cliente: {cliente} ({telefono})',
      '🛍️ Productos: {productos}',
      '💰 Total: {total}',
      '🚚 Entrega: {entrega}',
    ].join('\n'),
  },
  ORDER_CUSTOMER: {
    key: 'ORDER_CUSTOMER',
    name: 'Confirmación de pedido — mensaje al cliente',
    scope: 'catalog',
    audience: 'customer',
    limit: 700,
    required: ['{negocio}', '{cliente}', '{productos}', '{total}'],
    variables: CATALOG_VARIABLES,
    body: [
      'Hola {cliente}, recibimos tu pedido en {negocio}:',
      '',
      '🧾 Pedido: {pedido}',
      '🛍️ Productos: {productos}',
      '💰 Total: {total}',
      '🚚 Entrega: {entrega}',
      '',
      'Te avisamos apenas esté listo. 🙌',
    ].join('\n'),
  },
};

export function whatsappTemplateDefinition(
  key: WhatsappTemplateKey,
): WhatsappTemplateDefinition {
  return WHATSAPP_TEMPLATE_DEFINITIONS[key];
}

const TOKEN_PATTERN = /\{[a-záéíóúñ_]+\}/gi;

/**
 * Sustituye los tokens de una plantilla.
 *
 * Una línea cuyo token quedó sin valor se descarta entera, en vez de mandar
 * "👤 Especialista: " colgando: los datos opcionales (especialista, entrega,
 * número de pedido) no siempre existen, y esa línea vacía llega al cliente.
 * Una línea con varios tokens sobrevive mientras al menos uno tenga valor, para
 * no perder "Cliente: {cliente} ({telefono})" cuando falta solo el teléfono.
 */
export function renderWhatsappTemplate(
  body: string,
  values: Record<string, string | undefined | null>,
): string {
  const lines = body.split('\n').filter((line) => {
    const tokens = line.match(TOKEN_PATTERN);
    if (!tokens || tokens.length === 0) return true;
    return tokens.some((token) => {
      const value = values[token];
      return typeof value === 'string' && value.trim().length > 0;
    });
  });

  return lines
    .map((line) =>
      line.replace(TOKEN_PATTERN, (token) => values[token]?.trim() ?? ''),
    )
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .trim();
}
