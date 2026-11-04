import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import {
  ASSISTANT_VERTICALS,
  ASSISTANT_VERTICALS_FACTORY,
  AssistantVertical,
  assistantEnabledForVertical,
  FeatureOverrides,
  FeatureValue,
  normalizePlan,
  Plan,
  PLAN_FEATURES,
  planDefaults,
  setDisabledAssistantVerticals,
  setEditedPlanDefaults,
} from './plan-features';

const PLANS: Plan[] = ['BASIC', 'PRO', 'PREMIUM'];
const CONFIG_ID = 'singleton';
/** Con varias instancias, lo que guarda otra tarda como mucho esto en llegar. */
const REFRESH_MS = 60_000;

type Edited = Partial<Record<Plan, FeatureOverrides>>;

/** Lo que ve el backoffice. `null` en un límite = sin tope (JSON no tiene Infinity). */
export interface PlanFeaturesView {
  plans: Record<Plan, Record<string, boolean | number | null>>;
  factory: Record<Plan, Record<string, boolean | number | null>>;
  /** Claves que difieren del default de fábrica, por plan. */
  edited: Record<Plan, string[]>;
  /** Pregúntale a Lynko encendido por vertical. */
  assistantVerticals: Record<AssistantVertical, boolean>;
}

/** Lo guardado manda; lo que nunca se tocó queda en su valor de fábrica. */
function parseVerticals(raw: unknown): Record<AssistantVertical, boolean> {
  const stored = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return Object.fromEntries(
    ASSISTANT_VERTICALS.map((code) => [
      code,
      typeof stored[code] === 'boolean'
        ? (stored[code] as boolean)
        : ASSISTANT_VERTICALS_FACTORY[code],
    ]),
  ) as Record<AssistantVertical, boolean>;
}

const disabledOf = (verticals: Record<AssistantVertical, boolean>) =>
  ASSISTANT_VERTICALS.filter((code) => !verticals[code]);

const toJson = (value: FeatureValue): boolean | number | null =>
  typeof value === 'number' && !Number.isFinite(value) ? null : value;

function serialize(features: Record<string, FeatureValue>) {
  return Object.fromEntries(
    Object.entries(features).map(([key, value]) => [key, toJson(value)]),
  );
}

/** Lo guardado → lo que usa la resolución. Descarta claves y tipos que ya no existen. */
function parseStored(raw: unknown): Edited {
  if (!raw || typeof raw !== 'object') return {};
  const result: Edited = {};
  for (const plan of PLANS) {
    const values = (raw as Record<string, unknown>)[plan];
    if (!values || typeof values !== 'object') continue;
    const clean: FeatureOverrides = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      const factory = (PLAN_FEATURES[plan] as Record<string, FeatureValue>)[key];
      if (factory === undefined) continue;
      if (typeof factory === 'boolean' && typeof value === 'boolean') clean[key] = value;
      if (typeof factory === 'number') {
        if (value === null) clean[key] = Infinity;
        else if (typeof value === 'number' && value >= 0) clean[key] = value;
      }
    }
    if (Object.keys(clean).length) result[plan] = clean;
  }
  return result;
}

/**
 * Valores de los planes editables desde el backoffice.
 *
 * Mantiene en memoria lo editado (ver `setEditedPlanDefaults`) para que la
 * resolución de features siga siendo síncrona: la usa /auth/me en cada carga.
 */
@Injectable()
export class PlanFeaturesService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PlanFeaturesService.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit() {
    await this.reload();
    this.timer = setInterval(() => void this.reload(), REFRESH_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  /** Nunca lanza: sin base, se queda con lo último cargado (o con fábrica). */
  async reload(): Promise<void> {
    try {
      const row = await this.prisma.platformPricingConfig.findUnique({
        where: { id: CONFIG_ID },
        select: { planFeatureDefaults: true, assistantVerticals: true },
      });
      setEditedPlanDefaults(parseStored(row?.planFeatureDefaults));
      setDisabledAssistantVerticals(disabledOf(parseVerticals(row?.assistantVerticals)));
    } catch (error) {
      this.logger.warn(
        `could not load plan feature defaults: ${(error as Error)?.message ?? error}`,
      );
    }
  }

  async view(): Promise<PlanFeaturesView> {
    await this.reload();
    const plans = {} as PlanFeaturesView['plans'];
    const factory = {} as PlanFeaturesView['factory'];
    const edited = {} as PlanFeaturesView['edited'];
    for (const plan of PLANS) {
      const current = planDefaults(plan);
      plans[plan] = serialize(current);
      factory[plan] = serialize(PLAN_FEATURES[plan]);
      edited[plan] = Object.keys(current).filter(
        (key) => current[key] !== (PLAN_FEATURES[plan] as Record<string, FeatureValue>)[key],
      );
    }
    return { plans, factory, edited, assistantVerticals: this.currentVerticals() };
  }

  /** Enciende o apaga Pregúntale a Lynko para toda una vertical. */
  async setAssistantVertical(
    vertical: string,
    enabled: boolean,
    actorUserId: string,
  ): Promise<{ before: boolean; after: boolean }> {
    if (!ASSISTANT_VERTICALS.includes(vertical as AssistantVertical)) {
      throw new BadRequestException('Vertical inválida');
    }
    if (typeof enabled !== 'boolean') {
      throw new BadRequestException('enabled debe ser sí/no');
    }
    const row = await this.prisma.platformPricingConfig.findUnique({
      where: { id: CONFIG_ID },
      select: { assistantVerticals: true },
    });
    const current = parseVerticals(row?.assistantVerticals);
    const before = current[vertical as AssistantVertical];
    const next = { ...current, [vertical]: enabled };

    await this.prisma.platformPricingConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, assistantVerticals: next, updatedBy: actorUserId },
      update: { assistantVerticals: next, updatedBy: actorUserId },
    });
    setDisabledAssistantVerticals(disabledOf(next));
    return { before, after: enabled };
  }

  /** Lo que la landing puede ver: valores vigentes de cada plan y dónde hay Lynko. */
  publicPlans(): Pick<PlanFeaturesView, 'plans' | 'assistantVerticals'> {
    const plans = {} as PlanFeaturesView['plans'];
    for (const plan of PLANS) plans[plan] = serialize(planDefaults(plan));
    return { plans, assistantVerticals: this.currentVerticals() };
  }

  private currentVerticals() {
    return Object.fromEntries(
      ASSISTANT_VERTICALS.map((code) => [code, assistantEnabledForVertical(code)]),
    ) as Record<AssistantVertical, boolean>;
  }

  /**
   * Cambia valores de UN plan. Solo se guarda lo que difiere de fábrica: volver
   * a poner el valor de fábrica limpia la edición.
   */
  async update(
    planInput: string,
    values: Record<string, unknown>,
    actorUserId: string,
  ): Promise<{ before: FeatureOverrides; after: FeatureOverrides }> {
    const plan = normalizePlan(planInput);
    if (plan !== planInput?.toUpperCase()) {
      throw new BadRequestException('Plan inválido');
    }
    if (!values || typeof values !== 'object' || Array.isArray(values)) {
      throw new BadRequestException('values debe ser un objeto');
    }

    const factory = PLAN_FEATURES[plan] as Record<string, FeatureValue>;
    const row = await this.prisma.platformPricingConfig.findUnique({
      where: { id: CONFIG_ID },
      select: { planFeatureDefaults: true },
    });
    const stored = parseStored(row?.planFeatureDefaults);
    const before: FeatureOverrides = { ...(stored[plan] ?? {}) };
    const next: FeatureOverrides = { ...before };

    for (const [key, value] of Object.entries(values)) {
      const base = factory[key];
      if (base === undefined) throw new BadRequestException(`Feature desconocida: ${key}`);
      let parsed: FeatureValue;
      if (typeof base === 'boolean') {
        if (typeof value !== 'boolean') throw new BadRequestException(`${key} debe ser sí/no`);
        parsed = value;
      } else if (value === null) {
        parsed = Infinity;
      } else if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        parsed = value;
      } else {
        throw new BadRequestException(`${key} debe ser un entero ≥ 0, o vacío para sin tope`);
      }
      if (parsed === base) delete next[key];
      else next[key] = parsed;
    }

    const all: Edited = { ...stored, [plan]: next };
    if (!Object.keys(next).length) delete all[plan];
    const json = Object.fromEntries(
      Object.entries(all).map(([code, features]) => [code, serialize(features ?? {})]),
    ) as Prisma.InputJsonValue;

    await this.prisma.platformPricingConfig.upsert({
      where: { id: CONFIG_ID },
      create: { id: CONFIG_ID, planFeatureDefaults: json, updatedBy: actorUserId },
      update: { planFeatureDefaults: json, updatedBy: actorUserId },
    });
    setEditedPlanDefaults(all);
    return { before, after: next };
  }
}
