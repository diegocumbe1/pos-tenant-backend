/**
 * Catálogo CERRADO de variables de plantilla. Fuente única: el editor del
 * backoffice pinta sus chips desde `GET /platform/messaging/variables`, y al
 * guardar una plantilla se rechaza cualquier `{{variable}}` que no esté aquí.
 * Sin motor de templating y sin eval: solo reemplazo de texto.
 */
export interface TemplateVariable {
  key: string;
  label: string;
  example: string;
  group: 'negocio' | 'suscripcion' | 'pago' | 'plataforma';
}

export const TEMPLATE_VARIABLES: TemplateVariable[] = [
  // Negocio
  {
    key: 'negocio',
    label: 'Nombre del negocio',
    example: 'Ruta 43 Grill & Burger',
    group: 'negocio',
  },
  {
    key: 'dueno',
    label: 'Nombre del contacto',
    example: 'Lisdreth',
    group: 'negocio',
  },
  {
    key: 'slug',
    label: 'Slug del tenant',
    example: 'ruta-43-grill-burger',
    group: 'negocio',
  },

  // Suscripción
  { key: 'plan', label: 'Plan', example: 'Pro', group: 'suscripcion' },
  {
    key: 'ciclo',
    label: 'Ciclo de cobro',
    example: 'mensual',
    group: 'suscripcion',
  },
  {
    key: 'valor',
    label: 'Valor a pagar',
    example: '$ 92.000',
    group: 'suscripcion',
  },
  {
    key: 'fecha_vencimiento',
    label: 'Vencimiento (corto)',
    example: '10/08/2026',
    group: 'suscripcion',
  },
  {
    key: 'fecha_vencimiento_larga',
    label: 'Vencimiento (largo)',
    example: 'lunes 10 de agosto de 2026',
    group: 'suscripcion',
  },
  {
    key: 'dias_para_vencer',
    label: 'Días para vencer',
    example: '4',
    group: 'suscripcion',
  },
  {
    key: 'dias_vencido',
    label: 'Días vencido',
    example: '3',
    group: 'suscripcion',
  },
  {
    key: 'fecha_suspension',
    label: 'Suspensión (corto)',
    example: '15/08/2026',
    group: 'suscripcion',
  },
  {
    key: 'fecha_suspension_larga',
    label: 'Suspensión (largo)',
    example: 'sábado 15 de agosto de 2026',
    group: 'suscripcion',
  },
  {
    key: 'dias_de_holgura',
    label: 'Días de holgura',
    example: '5',
    group: 'suscripcion',
  },
  {
    key: 'ultimo_pago',
    label: 'Fecha del último pago',
    example: '10/07/2026',
    group: 'suscripcion',
  },
  {
    key: 'periodo',
    label: 'Periodo cubierto',
    example: '10/07/2026 – 10/08/2026',
    group: 'suscripcion',
  },

  // Pago
  {
    key: 'medios_pago',
    label: 'Bloque de medios de pago',
    example: 'Bre-B · Nu — Llave: @DCU963',
    group: 'pago',
  },
  {
    key: 'llave_breb',
    label: 'Llave Bre-B',
    example: '@DCU963',
    group: 'pago',
  },
  { key: 'link_pago', label: 'Link de pago', example: '—', group: 'pago' },

  // Plataforma
  {
    key: 'url_app',
    label: 'URL de la app del tenant',
    example: 'https://ruta-43-grill-burger.uselynko.com',
    group: 'plataforma',
  },
  {
    key: 'firma',
    label: 'Firma',
    example: 'Equipo Lynko',
    group: 'plataforma',
  },
];

export const TEMPLATE_VARIABLE_KEYS = new Set(
  TEMPLATE_VARIABLES.map((v) => v.key),
);

const PLACEHOLDER = /\{\{\s*([a-z0-9_]+)\s*\}\}/gi;

/** Variables usadas por una plantilla, sin repetir. */
export function extractVariables(body: string): string[] {
  const found = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER)) found.add(match[1]);
  return [...found];
}

/** Variables usadas que NO existen en el catálogo. */
export function unknownVariables(body: string): string[] {
  return extractVariables(body).filter(
    (key) => !TEMPLATE_VARIABLE_KEYS.has(key),
  );
}
