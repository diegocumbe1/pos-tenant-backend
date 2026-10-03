import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ExpenseTemplate, Prisma } from '@prisma/client';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  addCalendarDaysCO,
  calendarDayCO,
  dayStartCO,
} from '../common/date.util';
import { toExpenseDto } from './expense-dto';
import { resolveNature } from './expense-nature';
import { occurrencesBetween } from './expense-recurrence';
import {
  PLATFORM_SUBSCRIPTION_SOURCE,
  platformPeriodKey,
} from './platform-subscription-period';
import {
  CreateExpenseTemplateDto,
  PayExpenseOccurrenceDto,
  UpdateExpenseTemplateDto,
} from './dto/expense-template.dto';

/** Cuántos días hacia adelante se muestran como "próximos". */
const UPCOMING_DAYS = 31;
/**
 * Hasta dónde se mira hacia atrás buscando ocurrencias sin pagar. Una
 * plantilla creada con ancla vieja no puede llenar la lista con años de
 * "vencidos": lo que se dejó de pagar hace más de un año ya no es un pendiente,
 * es un dato que se corrige a mano.
 */
const OVERDUE_LOOKBACK_DAYS = 365;

/** Mediodía Colombia de un día calendario: la fecha del gasto nunca salta de día. */
function noonCO(day: string): Date {
  return new Date(dayStartCO(day).getTime() + 12 * 60 * 60 * 1000);
}

/**
 * Gastos recurrentes: la plantilla (el contrato) y sus ocurrencias por pagar.
 *
 * Las ocurrencias se calculan al consultar, no las crea un proceso programado:
 * Lynko no tiene scheduler y esto no lo necesita. Se guarda solo lo que ya
 * pasó — el gasto pagado o la ocurrencia omitida —, así que pausar, editar o
 * borrar la plantilla nunca deja gastos fantasma.
 */
@Injectable()
export class ExpenseTemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(ctx: TenantContext) {
    const templates = await this.prisma.expenseTemplate.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      orderBy: [{ isActive: 'desc' }, { createdAt: 'asc' }],
    });
    const today = calendarDayCO(new Date());
    const paid = await this.paidOccurrences(templates.map((t) => t.id));
    return templates.map((template) =>
      this.toDto(template, this.nextDue(template, paid, today)),
    );
  }

  async create(ctx: TenantContext, dto: CreateExpenseTemplateDto) {
    this.assertRange(dto.anchorDay, dto.endsOn);
    const template = await this.prisma.expenseTemplate.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        category: dto.category,
        concept: dto.concept.trim(),
        amountCOP: dto.amountCOP,
        nature: dto.nature ?? null,
        frequency: dto.frequency,
        anchorDay: dto.anchorDay,
        endsOn: dto.endsOn ?? null,
        note: dto.note?.trim() || null,
        sourceType: dto.sourceType ?? null,
      },
    });
    return this.toDto(template, null);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateExpenseTemplateDto) {
    const current = await this.assertOwn(ctx, id);
    this.assertRange(
      dto.anchorDay ?? current.anchorDay,
      dto.endsOn ?? current.endsOn,
    );
    // Cambiar el monto o la fecha NO toca los gastos ya pagados: cada uno
    // quedó con lo que costó ese mes. Solo cambia lo que viene.
    const template = await this.prisma.expenseTemplate.update({
      where: { id },
      data: {
        category: dto.category,
        concept: dto.concept?.trim(),
        amountCOP: dto.amountCOP,
        nature: dto.nature,
        frequency: dto.frequency,
        anchorDay: dto.anchorDay,
        endsOn: dto.endsOn,
        note: dto.note !== undefined ? dto.note.trim() || null : undefined,
        isActive: dto.isActive,
      },
    });
    return this.toDto(template, null);
  }

  /**
   * Soft-delete. Los gastos que ya se pagaron con esta plantilla se quedan
   * como están: son plata que salió y su historia no depende del contrato.
   */
  async remove(ctx: TenantContext, id: string) {
    await this.assertOwn(ctx, id);
    await this.prisma.expenseTemplate.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
    return { ok: true };
  }

  /**
   * Lo que hay por pagar: vencido (hasta un año atrás), hoy y próximo mes.
   * Ni pagado ni omitido.
   */
  async due(ctx: TenantContext) {
    const templates = await this.prisma.expenseTemplate.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        isActive: true,
      },
    });
    const today = calendarDayCO(new Date());
    const from = addCalendarDaysCO(today, -OVERDUE_LOOKBACK_DAYS);
    const to = addCalendarDaysCO(today, UPCOMING_DAYS);
    const paid = await this.paidOccurrences(templates.map((t) => t.id));
    const lynkoCovered = await this.lynkoCoveredPeriods(ctx, templates);

    const rows = templates.flatMap((template) =>
      occurrencesBetween(template, from, to)
        .filter(
          (day) =>
            !paid.has(`${template.id}:${day}`) &&
            !template.skippedOccurrences.includes(day) &&
            // El cobro de Lynko de ese periodo ya se registró desde la tarjeta
            // de la suscripción: pedirlo otra vez aquí lo duplicaría.
            !(
              template.sourceType === PLATFORM_SUBSCRIPTION_SOURCE &&
              lynkoCovered.covers(day, template.frequency === 'ANNUAL')
            ),
        )
        .map((day) => ({
          templateId: template.id,
          occurrence: day,
          concept: template.concept,
          category: template.category,
          nature: resolveNature(template.category, template.nature),
          frequency: template.frequency,
          amountCOP: template.amountCOP,
          sourceType: template.sourceType,
          status:
            day < today
              ? ('OVERDUE' as const)
              : day <= addCalendarDaysCO(today, 7)
                ? ('DUE_SOON' as const)
                : ('UPCOMING' as const),
        })),
    );
    return rows.sort((a, b) => a.occurrence.localeCompare(b.occurrence));
  }

  /**
   * Paga una ocurrencia: crea el gasto real.
   *
   * IDEMPOTENTE: el par (plantilla, ocurrencia) es único en la tabla. Un doble
   * clic o un reintento devuelve el gasto que ya existe en vez de pagar dos
   * veces el arriendo del mismo mes.
   */
  async pay(ctx: TenantContext, id: string, dto: PayExpenseOccurrenceDto) {
    const template = await this.assertOwn(ctx, id);
    if (!this.isOccurrence(template, dto.occurrence)) {
      throw new BadRequestException(
        `El ${dto.occurrence} no es una fecha de este gasto recurrente`,
      );
    }

    const existing = await this.prisma.expense.findUnique({
      where: {
        templateId_templateOccurrence: {
          templateId: id,
          templateOccurrence: dto.occurrence,
        },
      },
    });
    if (existing) return toExpenseDto(existing);

    // Lynko: si ese periodo ya se registró desde un cobro real de la
    // plataforma, se enlaza ese gasto a esta fecha en vez de crear otro.
    if (template.sourceType === PLATFORM_SUBSCRIPTION_SOURCE) {
      const annual = template.frequency === 'ANNUAL';
      const sameCharge = (
        await this.prisma.expense.findMany({
          where: {
            tenantId: ctx.tenantId,
            sourceType: PLATFORM_SUBSCRIPTION_SOURCE,
            templateId: null,
          },
        })
      ).find(
        (row) =>
          platformPeriodKey(row.incurredAt, annual) ===
          platformPeriodKey(dto.occurrence, annual),
      );
      if (sameCharge) {
        const linked = await this.prisma.expense.update({
          where: { id: sameCharge.id },
          data: { templateId: id, templateOccurrence: dto.occurrence },
        });
        return toExpenseDto(linked);
      }
    }

    const paidOn = dto.paidOn ?? calendarDayCO(new Date());
    try {
      const expense = await this.prisma.expense.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          category: template.category,
          concept: template.concept,
          amountCOP:
            dto.amountCOP ??
            Math.max(0, template.amountCOP - (dto.discountCOP ?? 0)),
          discountCOP: dto.discountCOP || null,
          incurredAt: noonCO(paidOn),
          frequency: template.frequency,
          isRecurring: true,
          nature: template.nature,
          note: dto.note?.trim() || template.note,
          templateId: id,
          templateOccurrence: dto.occurrence,
          sourceType: template.sourceType,
        },
      });
      return toExpenseDto(expense);
    } catch (error) {
      // Carrera entre dos pagos simultáneos: el otro ganó; se devuelve el suyo.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        const winner = await this.prisma.expense.findUniqueOrThrow({
          where: {
            templateId_templateOccurrence: {
              templateId: id,
              templateOccurrence: dto.occurrence,
            },
          },
        });
        return toExpenseDto(winner);
      }
      throw error;
    }
  }

  /** "Ese mes no hubo": la ocurrencia deja de estar por pagar sin crear gasto. */
  async skip(ctx: TenantContext, id: string, occurrence: string) {
    const template = await this.assertOwn(ctx, id);
    if (!this.isOccurrence(template, occurrence)) {
      throw new BadRequestException(
        `El ${occurrence} no es una fecha de este gasto recurrente`,
      );
    }
    if (template.skippedOccurrences.includes(occurrence)) {
      return this.toDto(template, null);
    }
    const updated = await this.prisma.expenseTemplate.update({
      where: { id },
      data: { skippedOccurrences: { push: occurrence } },
    });
    return this.toDto(updated, null);
  }

  // ─── Interno ───────────────────────────────────────────────────────────────

  private isOccurrence(template: ExpenseTemplate, day: string) {
    return occurrencesBetween(template, day, day).includes(day);
  }

  private assertRange(anchorDay: string, endsOn?: string | null) {
    if (endsOn && endsOn < anchorDay) {
      throw new BadRequestException(
        'La fecha de fin no puede ser anterior a la primera fecha',
      );
    }
  }

  private async assertOwn(ctx: TenantContext, id: string) {
    const template = await this.prisma.expenseTemplate.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
    });
    if (!template)
      throw new NotFoundException(`Expense template ${id} not found`);
    return template;
  }

  /**
   * Periodos de Lynko ya registrados como gasto en el negocio (por cualquier
   * camino), para no volver a pedirlos en "Por pagar".
   */
  /**
   * Qué fechas de Lynko ya están registradas como gasto en el negocio, por
   * cualquier camino, para no volver a pedirlas en "Por pagar":
   * - por PERIODO de cobro: un cobro registrado cubre todo su periodo (una
   *   cortesía del 3 de agosto al 4 de enero cubre esos cinco meses);
   * - por MES (o año): un gasto de Lynko anotado a mano o pagado desde la
   *   fecha del recurrente cubre ese mes.
   */
  private async lynkoCoveredPeriods(
    ctx: TenantContext,
    templates: ExpenseTemplate[],
  ) {
    const none = { covers: () => false };
    const lynko = templates.filter(
      (t) => t.sourceType === PLATFORM_SUBSCRIPTION_SOURCE,
    );
    if (lynko.length === 0) return none;

    const rows = await this.prisma.expense.findMany({
      where: {
        tenantId: ctx.tenantId,
        sourceType: PLATFORM_SUBSCRIPTION_SOURCE,
      },
      select: { incurredAt: true, sourceId: true },
    });
    const paymentIds = rows
      .map((r) => r.sourceId)
      .filter((id): id is string => !!id);
    const periods = paymentIds.length
      ? await this.prisma.subscriptionPayment.findMany({
          where: { tenantId: ctx.tenantId, id: { in: paymentIds } },
          select: { periodStart: true, periodEnd: true },
        })
      : [];
    // El fin del periodo es el inicio del siguiente: se cubre hasta el día
    // anterior, para no tapar la fecha de cobro que sigue.
    const ranges = periods.map((p) => ({
      from: calendarDayCO(p.periodStart),
      to: calendarDayCO(p.periodEnd),
    }));

    return {
      covers: (day: string, annual: boolean) => {
        if (ranges.some((r) => day >= r.from && day < r.to)) return true;
        const key = platformPeriodKey(day, annual);
        return rows.some(
          (r) => platformPeriodKey(r.incurredAt, annual) === key,
        );
      },
    };
  }

  /** 'plantilla:YYYY-MM-DD' de todo lo ya pagado. */
  private async paidOccurrences(templateIds: string[]) {
    if (templateIds.length === 0) return new Set<string>();
    const rows = await this.prisma.expense.findMany({
      where: { templateId: { in: templateIds } },
      select: { templateId: true, templateOccurrence: true },
    });
    return new Set(rows.map((r) => `${r.templateId}:${r.templateOccurrence}`));
  }

  /** Próxima ocurrencia sin pagar ni omitir, para mostrarla en la lista. */
  private nextDue(template: ExpenseTemplate, paid: Set<string>, today: string) {
    if (!template.isActive) return null;
    const from = addCalendarDaysCO(today, -OVERDUE_LOOKBACK_DAYS);
    const to = addCalendarDaysCO(today, 400);
    return (
      occurrencesBetween(template, from, to).find(
        (day) =>
          !paid.has(`${template.id}:${day}`) &&
          !template.skippedOccurrences.includes(day),
      ) ?? null
    );
  }

  private toDto(template: ExpenseTemplate, nextDue: string | null) {
    return {
      id: template.id,
      category: template.category,
      concept: template.concept,
      amountCOP: template.amountCOP,
      nature: resolveNature(template.category, template.nature),
      frequency: template.frequency,
      anchorDay: template.anchorDay,
      endsOn: template.endsOn,
      note: template.note,
      isActive: template.isActive,
      sourceType: template.sourceType,
      nextDue,
      createdAt: template.createdAt.toISOString(),
    };
  }
}
