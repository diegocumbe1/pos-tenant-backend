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
    aiChatMonthlyLimit: 80,
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
    aiChatMonthlyLimit: Infinity,
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

function normalizePlan(plan: string): Plan {
  const upper = plan?.toUpperCase();
  return upper === 'PRO' || upper === 'PREMIUM' ? (upper as Plan) : 'BASIC';
}

/**
 * Features efectivos de un tenant = defaults del plan + overrides del tenant.
 * Espeja `resolveTenantFeatures` del FE (`lib/plans.ts`).
 */
export function resolveEffectiveFeatures(
  plan: string,
  featureOverrides?: FeatureOverrides | null,
): Record<string, FeatureValue> {
  return {
    ...PLAN_FEATURES[normalizePlan(plan)],
    ...(featureOverrides ?? {}),
  };
}

/**
 * Valor efectivo de una feature (override ?? default del plan).
 * Espeja `resolveTenantValue` del FE.
 */
export function resolveFeatureValue(
  plan: string,
  feature: PlanFeatureKey,
  featureOverrides?: FeatureOverrides | null,
): FeatureValue {
  const override = featureOverrides?.[feature];
  if (override !== undefined) return override;
  return PLAN_FEATURES[normalizePlan(plan)][feature];
}
