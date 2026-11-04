import { ForbiddenException, Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import {
  addCalendarDaysCO,
  dayEndCO,
  dayStartCO,
  monthEndDayCO,
  monthStartDayCO,
} from '../../common/date.util';
import {
  assistantEnabledForVertical,
  FeatureOverrides,
  resolveFeatureValue,
} from '../../platform/plans/plan-features';

export interface AssistantUsage {
  /** El plan (o el override del backoffice) incluye Pregúntale a Lynko. */
  enabled: boolean;
  /** Por qué está apagado: el plan del negocio, o el interruptor de su vertical. */
  disabledBy?: 'plan' | 'vertical';
  /** Consultas del mes en curso, hora Colombia, sumando todos los canales. */
  used: number;
  /** Tope del mes. `null` = sin tope. */
  limit: number | null;
  /** Día en que vuelve a cero ("2026-12-01"). */
  resetsOn: string;
}

/** Sin plan o sin cupo. Subclase de Forbidden para que ningún canal lo deje pasar por descuido. */
export class AssistantQuotaException extends ForbiddenException {
  constructor(
    readonly reason: 'plan' | 'quota',
    readonly usage: AssistantUsage,
    /** Para que el canal lo diga con nombre: Alexa no tiene el negocio a mano al atrapar el error. */
    readonly businessName = 'El negocio',
  ) {
    super({
      code: reason === 'plan' ? 'ASSISTANT_PLAN' : 'ASSISTANT_QUOTA',
      message:
        reason === 'plan'
          ? 'El plan del negocio no incluye Pregúntale a Lynko.'
          : 'El negocio ya usó las consultas de Lynko de este mes.',
      usage,
    });
  }
}

// Lo que NO gasta cupo: lo que se negó o falló sin responder nada.
const NOT_COUNTED = ['DENIED_PERMISSION', 'DENIED_PLAN', 'ERROR'] as const;

/**
 * Consultas de Lynko del negocio en el mes en curso (hora Colombia, todos los
 * canales). Función suelta para que el backoffice muestre el consumo sin
 * depender del módulo del asistente.
 */
export function countAssistantQueriesThisMonth(
  prisma: PrismaService,
  tenantId: string,
): Promise<number> {
  return prisma.assistantQueryLog.count({
    where: {
      tenantId,
      resolvedTo: null,
      outcome: { notIn: [...NOT_COUNTED] },
      at: { gte: dayStartCO(monthStartDayCO()), lte: dayEndCO(monthEndDayCO()) },
    },
  });
}

/**
 * Cupo mensual de Pregúntale a Lynko por negocio.
 *
 * Hoy no hay LLM: el tope existe para que un negocio no convierta el asistente
 * en una carga sostenida sobre el servidor. Pro ≈ 3 consultas al día, Premium ≈ 10.
 *
 * Se cuenta sobre `assistant_query_log`, la misma bitácora de la telemetría:
 * una fila con `resolvedTo = null` es una consulta. No hay contador aparte que
 * se pueda desincronizar. El chat web reporta sus consultas por telemetría
 * (fire-and-forget), así que ahí el conteo puede ir unos segundos atrás; en
 * WhatsApp y Alexa el tope se aplica aquí, antes de responder.
 */
@Injectable()
export class AssistantQuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async usage(tenantId: string): Promise<AssistantUsage> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, featureOverrides: true, vertical: { select: { code: true } } },
    });
    const overrides = (tenant?.featureOverrides ?? null) as FeatureOverrides | null;
    const plan = tenant?.plan ?? 'BASIC';
    const vertical = tenant?.vertical?.code ?? null;
    const verticalOn = assistantEnabledForVertical(vertical);
    const enabled = verticalOn && resolveFeatureValue(plan, 'aiChat', overrides) === true;
    const rawLimit = resolveFeatureValue(plan, 'aiChatMonthlyLimit', overrides);
    const limit =
      typeof rawLimit === 'number' && Number.isFinite(rawLimit)
        ? Math.max(0, rawLimit)
        : rawLimit === false
          ? 0
          : null;

    const used = enabled ? await countAssistantQueriesThisMonth(this.prisma, tenantId) : 0;

    return {
      enabled,
      ...(enabled ? {} : { disabledBy: verticalOn ? ('plan' as const) : ('vertical' as const) }),
      used,
      limit,
      resetsOn: addCalendarDaysCO(monthEndDayCO(), 1),
    };
  }

  /** Lanza `AssistantQuotaException` si el negocio no puede hacer otra consulta. */
  async assertAvailable(tenantId: string, businessName?: string): Promise<AssistantUsage> {
    const usage = await this.usage(tenantId);
    if (!usage.enabled) throw new AssistantQuotaException('plan', usage, businessName);
    if (usage.limit !== null && usage.used >= usage.limit) {
      throw new AssistantQuotaException('quota', usage, businessName);
    }
    return usage;
  }
}
