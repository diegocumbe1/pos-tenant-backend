/**
 * Catálogo de features por plan — ESPEJO EXACTO del FE
 * (`pos-system/core/config/plans.config.ts` → `PLAN_FEATURES`).
 *
 * ⚠️ Single source of truth del lado backend. Mantener idéntico al FE: mismas keys
 * y mismos valores por plan. Anti-patrón: divergir (docs/BACKOFFICE_ARCHITECTURE.md §7).
 *
 * `Infinity` = sin límite (igual que el FE). Al serializar a JSON, Infinity se
 * convierte en `null`; el consumidor trata `null` como "ilimitado".
 */

export type Plan = 'BASIC' | 'PRO' | 'PREMIUM';

export const PLAN_FEATURES = {
  BASIC: {
    // Estructural
    maxBranches: 1,
    maxTerminals: 1,
    maxUsers: 3,
    maxTables: 10,
    maxMenuItems: 50,
    // Features operativas
    kitchenDisplay: false,
    splitPayments: false,
    inventory: false,
    // Roles habilitados
    kitchenRole: false,
    rbacEditable: false,
    // IA / consumo
    aiChat: false,
    aiChatMonthlyLimit: 0,
    // Personalización
    menuBuilder: false,
    themeCustomization: false,
    // Analytics y reportes
    analytics: false,
    exportReports: false,
    audit: false,
    // Futuras
    loyaltyProgram: false,
    multipleLocations: false,
    customReceipts: false,
    // Barber
    appointmentScheduling: false,
    whatsappReminders: false,
    googleCalendarSync: false,
  },
  PRO: {
    maxBranches: 3,
    maxTerminals: 5,
    maxUsers: 15,
    maxTables: 30,
    maxMenuItems: 200,
    kitchenDisplay: true,
    splitPayments: true,
    inventory: true,
    kitchenRole: true,
    rbacEditable: true,
    aiChat: true,
    // ≈ 3 consultas al día. No hay LLM: el tope cuida la carga del servidor.
    aiChatMonthlyLimit: 100,
    menuBuilder: false,
    themeCustomization: false,
    analytics: true,
    exportReports: true,
    audit: false,
    loyaltyProgram: false,
    multipleLocations: true,
    customReceipts: true,
    appointmentScheduling: true,
    whatsappReminders: true,
    googleCalendarSync: false,
  },
  PREMIUM: {
    maxBranches: Infinity,
    maxTerminals: Infinity,
    maxUsers: Infinity,
    maxTables: Infinity,
    maxMenuItems: Infinity,
    kitchenDisplay: true,
    splitPayments: true,
    inventory: true,
    kitchenRole: true,
    rbacEditable: true,
    aiChat: true,
    // ≈ 10 consultas al día. Antes Infinity: sin tope, un solo negocio podía
    // convertir el asistente en carga sostenida.
    aiChatMonthlyLimit: 300,
    menuBuilder: true,
    themeCustomization: true,
    analytics: true,
    exportReports: true,
    audit: true,
    loyaltyProgram: true,
    multipleLocations: true,
    customReceipts: true,
    appointmentScheduling: true,
    whatsappReminders: true,
    googleCalendarSync: true,
  },
} as const satisfies Record<Plan, Record<string, boolean | number>>;

export type PlanFeatures = (typeof PLAN_FEATURES)[Plan];
export type PlanFeatureKey = keyof PlanFeatures;

export type FeatureValue = boolean | number;
export type FeatureOverrides = Record<string, FeatureValue>;

export function normalizePlan(plan: string): Plan {
  const upper = plan?.toUpperCase();
  return upper === 'PRO' || upper === 'PREMIUM' ? (upper as Plan) : 'BASIC';
}

// ─── Valores editados desde el backoffice ────────────────────────────────────
//
// `PLAN_FEATURES` es el default de fábrica. El super-admin puede subir o bajar
// cualquier valor de un plan (Ajustes → Planes) y eso se guarda en
// `platform_pricing_config.planFeatureDefaults`. `PlanFeaturesService` lo carga
// aquí al arrancar, lo refresca cada minuto y lo reemplaza al guardar.
//
// Vive en memoria y no se consulta en cada llamada porque la resolución es
// síncrona y la usan rutas calientes (/auth/me). Precedencia:
//   PLAN_FEATURES[plan]  ←  editado en el backoffice  ←  override del tenant

let editedDefaults: Partial<Record<Plan, FeatureOverrides>> = {};

export function setEditedPlanDefaults(
  value: Partial<Record<Plan, FeatureOverrides>>,
): void {
  editedDefaults = value;
}

// ─── Pregúntale a Lynko por vertical ──────────────────────────────────────────
//
// Interruptor global del backoffice, con precedencia AND: apagar una vertical
// apaga Lynko a TODOS sus negocios, sin importar plan ni override; encenderla
// no se lo regala a un plan que no lo incluye.
//
// De fábrica solo retail: es la única vertical donde Lynko responde con datos
// reales. El chat de restaurante solo funciona en demo (ver el aviso de
// `lib/ai-chat/context-builder.ts` en el FE) y en agenda no está montado.

export const ASSISTANT_VERTICALS = ['retail', 'restaurant', 'barber'] as const;
export type AssistantVertical = (typeof ASSISTANT_VERTICALS)[number];

export const ASSISTANT_VERTICALS_FACTORY: Record<AssistantVertical, boolean> = {
  retail: true,
  restaurant: false,
  barber: false,
};

const factoryDisabled = () =>
  ASSISTANT_VERTICALS.filter((code) => !ASSISTANT_VERTICALS_FACTORY[code]);

let disabledAssistantVerticals = new Set<string>(factoryDisabled());

export function setDisabledAssistantVerticals(codes: Iterable<string>): void {
  disabledAssistantVerticals = new Set(codes);
}

export function assistantEnabledForVertical(vertical?: string | null): boolean {
  return !vertical || !disabledAssistantVerticals.has(vertical);
}

/** Defaults efectivos de un plan: fábrica + lo editado en el backoffice. */
export function planDefaults(plan: string): Record<string, FeatureValue> {
  const code = normalizePlan(plan);
  return { ...PLAN_FEATURES[code], ...(editedDefaults[code] ?? {}) };
}

/**
 * Features efectivos de un tenant = defaults del plan + overrides del tenant.
 * Espeja `resolveTenantFeatures` del FE (`lib/plans.ts`).
 */
export function resolveEffectiveFeatures(
  plan: string,
  featureOverrides?: FeatureOverrides | null,
  /** Con la vertical se aplica el interruptor de Lynko por vertical. */
  vertical?: string | null,
): Record<string, FeatureValue> {
  const features = {
    ...planDefaults(plan),
    ...(featureOverrides ?? {}),
  };
  if (!assistantEnabledForVertical(vertical)) features.aiChat = false;
  return features;
}

/**
 * Valor efectivo de una feature (override ?? default del plan).
 * Espeja `resolveTenantValue` del FE.
 */
export function resolveFeatureValue(
  plan: string,
  feature: PlanFeatureKey,
  featureOverrides?: FeatureOverrides | null,
  vertical?: string | null,
): FeatureValue {
  if (feature === 'aiChat' && !assistantEnabledForVertical(vertical)) return false;
  const override = featureOverrides?.[feature];
  if (override !== undefined) return override;
  return planDefaults(plan)[feature];
}
