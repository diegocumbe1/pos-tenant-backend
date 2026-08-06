import { PlatformMessageChannel } from '@prisma/client';

export interface SeedTemplate {
  key: string;
  name: string;
  description: string;
  channel: PlatformMessageChannel;
  subject?: string;
  body: string;
}

const FOOTER =
  'Cuando pagues, mándanos el comprobante y lo registramos el mismo día.';

/**
 * Plantillas del sistema. Se siembran al arrancar (idempotente) y quedan
 * editables desde la consola; `restore` las devuelve a este texto.
 *
 * El cuerpo se escribe en formato WhatsApp (*negrita*); el correo lo convierte a
 * HTML. Nota sobre `payment_reminder`: sirve tanto para el aviso previo como
 * para la mora, porque el servicio elige la variante según si ya venció.
 */
export const SEED_TEMPLATES: SeedTemplate[] = [
  // ─── Recordatorio de pago (antes del vencimiento) ───────────────────────────
  {
    key: 'payment_reminder',
    name: 'Recordatorio de pago',
    description: 'Aviso antes del vencimiento, con los medios de pago.',
    channel: PlatformMessageChannel.WHATSAPP,
    body: [
      'Hola {{dueno}} 👋',
      '',
      'Te recordamos que el plan *{{plan}}* de Lynko de *{{negocio}}* vence el *{{fecha_vencimiento_larga}}*.',
      'Te quedan *{{dias_para_vencer}} días* para realizar el pago.',
      '',
      '💵 Valor: *{{valor}}* · {{ciclo}}',
      '📅 Vence: {{fecha_vencimiento}}',
      '⏳ Si no recibimos el pago, el servicio se suspende el *{{fecha_suspension_larga}}* y se reactiva apenas confirmemos el pago.',
      '',
      '{{medios_pago}}',
      '',
      FOOTER,
      '',
      'Gracias,',
      '{{firma}}',
    ].join('\n'),
  },
  {
    key: 'payment_reminder',
    name: 'Recordatorio de pago (correo)',
    description: 'Aviso antes del vencimiento, con los medios de pago.',
    channel: PlatformMessageChannel.EMAIL,
    subject:
      '{{negocio}} · tu plan {{plan}} de Lynko vence el {{fecha_vencimiento}}',
    body: [
      'Hola {{dueno}},',
      '',
      'Te recordamos que el plan *{{plan}}* de Lynko de *{{negocio}}* vence el *{{fecha_vencimiento_larga}}*.',
      'Te quedan *{{dias_para_vencer}} días* para realizar el pago.',
      '',
      'Valor: *{{valor}}* · {{ciclo}}',
      'Vence: {{fecha_vencimiento}}',
      'Si no recibimos el pago, el servicio se suspende el *{{fecha_suspension_larga}}* y se reactiva apenas confirmemos el pago.',
      '',
      '{{medios_pago}}',
      '',
      FOOTER,
      '',
      'Gracias,',
      '{{firma}}',
    ].join('\n'),
  },

  // ─── Recordatorio de pago vencido (mora) ────────────────────────────────────
  {
    key: 'payment_overdue',
    name: 'Pago vencido',
    description: 'Variante de mora: se envía sola cuando la fecha ya pasó.',
    channel: PlatformMessageChannel.WHATSAPP,
    body: [
      'Hola {{dueno}} 👋',
      '',
      'El plan *{{plan}}* de Lynko de *{{negocio}}* venció el *{{fecha_vencimiento_larga}}* — hace *{{dias_vencido}} días*.',
      '',
      '💵 Valor pendiente: *{{valor}}* · {{ciclo}}',
      '⚠️ El servicio se suspende el *{{fecha_suspension_larga}}* si no recibimos el pago.',
      '',
      '{{medios_pago}}',
      '',
      FOOTER,
      '',
      'Gracias,',
      '{{firma}}',
    ].join('\n'),
  },
  {
    key: 'payment_overdue',
    name: 'Pago vencido (correo)',
    description: 'Variante de mora: se envía sola cuando la fecha ya pasó.',
    channel: PlatformMessageChannel.EMAIL,
    subject: '{{negocio}} · tu plan {{plan}} venció hace {{dias_vencido}} días',
    body: [
      'Hola {{dueno}},',
      '',
      'El plan *{{plan}}* de Lynko de *{{negocio}}* venció el *{{fecha_vencimiento_larga}}* — hace *{{dias_vencido}} días*.',
      '',
      'Valor pendiente: *{{valor}}* · {{ciclo}}',
      'El servicio se suspende el *{{fecha_suspension_larga}}* si no recibimos el pago.',
      '',
      '{{medios_pago}}',
      '',
      FOOTER,
      '',
      'Gracias,',
      '{{firma}}',
    ].join('\n'),
  },

  // ─── Datos de pago (envío suelto) ───────────────────────────────────────────
  {
    key: 'payment_details',
    name: 'Datos de pago',
    description: 'Solo los medios de pago, sin recordatorio de vencimiento.',
    channel: PlatformMessageChannel.WHATSAPP,
    body: [
      'Hola {{dueno}} 👋',
      '',
      'Te compartimos los datos para el pago del plan *{{plan}}* de *{{negocio}}* ({{valor}} · {{ciclo}}):',
      '',
      '{{medios_pago}}',
      '',
      FOOTER,
      '',
      '{{firma}}',
    ].join('\n'),
  },
  {
    key: 'payment_details',
    name: 'Datos de pago (correo)',
    description: 'Solo los medios de pago, sin recordatorio de vencimiento.',
    channel: PlatformMessageChannel.EMAIL,
    subject: 'Datos de pago · {{negocio}} · Lynko',
    body: [
      'Hola {{dueno}},',
      '',
      'Te compartimos los datos para el pago del plan *{{plan}}* de *{{negocio}}* ({{valor}} · {{ciclo}}):',
      '',
      '{{medios_pago}}',
      '',
      FOOTER,
      '',
      '{{firma}}',
    ].join('\n'),
  },

  // ─── Bienvenida ─────────────────────────────────────────────────────────────
  {
    key: 'welcome',
    name: 'Bienvenida a Lynko',
    description: 'Se envía al activar la cuenta.',
    channel: PlatformMessageChannel.WHATSAPP,
    body: [
      '¡Bienvenido a Lynko, {{dueno}}! 🎉',
      '',
      '*{{negocio}}* ya está activo con el plan *{{plan}}*.',
      '',
      '🔗 Entra a tu punto de venta: {{url_app}}',
      '📅 Tu próximo pago es el {{fecha_vencimiento}} ({{valor}} · {{ciclo}}).',
      '',
      'Cualquier duda nos escribes por aquí mismo.',
      '',
      '{{firma}}',
    ].join('\n'),
  },
  {
    key: 'welcome',
    name: 'Bienvenida a Lynko (correo)',
    description: 'Se envía al activar la cuenta.',
    channel: PlatformMessageChannel.EMAIL,
    subject: '¡Bienvenido a Lynko, {{negocio}}!',
    body: [
      '¡Bienvenido a Lynko, {{dueno}}!',
      '',
      '*{{negocio}}* ya está activo con el plan *{{plan}}*.',
      '',
      'Entra a tu punto de venta: {{url_app}}',
      'Tu próximo pago es el {{fecha_vencimiento}} ({{valor}} · {{ciclo}}).',
      '',
      'Cualquier duda, respóndenos este correo.',
      '',
      '{{firma}}',
    ].join('\n'),
  },

  // ─── Pago recibido ──────────────────────────────────────────────────────────
  {
    key: 'payment_received',
    name: 'Pago recibido',
    description: 'Confirmación después de registrar un pago.',
    channel: PlatformMessageChannel.WHATSAPP,
    body: [
      '¡Gracias {{dueno}}! ✅',
      '',
      'Registramos tu pago de *{{valor}}* del plan *{{plan}}* de *{{negocio}}*.',
      '',
      '📅 Cubre: {{periodo}}',
      '🔄 Próximo pago: {{fecha_vencimiento}}',
      '',
      '{{firma}}',
    ].join('\n'),
  },
  {
    key: 'payment_received',
    name: 'Pago recibido (correo)',
    description: 'Confirmación después de registrar un pago.',
    channel: PlatformMessageChannel.EMAIL,
    subject: 'Recibimos tu pago · {{negocio}}',
    body: [
      '¡Gracias {{dueno}}!',
      '',
      'Registramos tu pago de *{{valor}}* del plan *{{plan}}* de *{{negocio}}*.',
      '',
      'Cubre: {{periodo}}',
      'Próximo pago: {{fecha_vencimiento}}',
      '',
      '{{firma}}',
    ].join('\n'),
  },

  // ─── Servicio suspendido ────────────────────────────────────────────────────
  {
    key: 'service_suspended',
    name: 'Servicio suspendido',
    description: 'Aviso de corte por falta de pago.',
    channel: PlatformMessageChannel.WHATSAPP,
    body: [
      'Hola {{dueno}},',
      '',
      'El servicio de *{{negocio}}* quedó *suspendido* por el pago pendiente del plan {{plan}}.',
      '',
      '💵 Valor pendiente: *{{valor}}*',
      '🔓 Se reactiva apenas confirmemos el pago — no se pierde ninguna información.',
      '',
      '{{medios_pago}}',
      '',
      '{{firma}}',
    ].join('\n'),
  },
  {
    key: 'service_suspended',
    name: 'Servicio suspendido (correo)',
    description: 'Aviso de corte por falta de pago.',
    channel: PlatformMessageChannel.EMAIL,
    subject: 'Servicio suspendido · {{negocio}}',
    body: [
      'Hola {{dueno}},',
      '',
      'El servicio de *{{negocio}}* quedó *suspendido* por el pago pendiente del plan {{plan}}.',
      '',
      'Valor pendiente: *{{valor}}*',
      'Se reactiva apenas confirmemos el pago — no se pierde ninguna información.',
      '',
      '{{medios_pago}}',
      '',
      '{{firma}}',
    ].join('\n'),
  },
];

/** Medio de pago inicial: el Bre-B de Nu que se usa hoy para cobrar. */
export const SEED_PAYMENT_METHOD = {
  kind: 'breb',
  label: 'Bre-B · Nu',
  bank: 'Nu Colombia',
  reference: '@DCU963',
  instructions: 'Paga desde cualquier banco o billetera buscando la llave.',
  isDefault: true,
  isActive: true,
  sortOrder: 0,
};
