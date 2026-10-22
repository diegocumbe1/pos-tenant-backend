import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RetailPaymentCommitment } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  addCalendarDaysCO,
  calendarDayCO,
  diffCalendarDaysCO,
  formatCOP,
  formatDateCO,
} from '../../../common/date.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { lotDate, lotDay } from '../../shared/retail-stock-lots';
import {
  CreatePaymentCommitmentDto,
  UpdatePaymentCommitmentDto,
} from './dto/retail-payment-commitment.dto';

type Tx = Prisma.TransactionClient;

/** Cómo se ve un compromiso hoy. INCUMPLIDO se deriva, no se guarda. */
export type CommitmentState = 'PENDING' | 'BROKEN' | 'FULFILLED' | 'CANCELLED';

/**
 * [VERTICAL_RETAIL] Compromisos de pago: "paga el viernes", con recordatorio.
 *
 * Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md §6 (pos-system).
 *
 * EL ESTADO SALE DE LA PLATA. Cumplido = el saldo de sus ventas llegó a 0, y
 * se guarda la primera vez que se ve. Incumplido = pasó la fecha y queda
 * saldo, y NO se guarda: si pagan tarde, el compromiso igual se cumple sin que
 * nadie lo reabra.
 *
 * SIN JOBS. El recordatorio lo manda una persona con un botón el día que toca
 * (`remindToday`); `remindedAt` evita mandarlo dos veces. Si algún día se
 * aprueba el scheduler (§7), este mismo `remindToday` es lo que él leería.
 *
 * UN COMPROMISO VIVO POR VENTA. Pactar uno nuevo sobre una venta cancela el
 * anterior: dos fechas vivas para la misma deuda no dicen cuál vale.
 */
@Injectable()
export class RetailPaymentCommitmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  async create(ctx: TenantContext, dto: CreatePaymentCommitmentDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const saleIds = [...new Set(dto.saleIds)];
    const sales = await this.openSales(ctx, saleIds);
    if (sales.length !== saleIds.length) {
      throw new BadRequestException(
        'Alguna de esas ventas no existe, está anulada o ya está pagada',
      );
    }
    const customers = new Set(sales.map((sale) => sale.customerId ?? ''));
    if (customers.size > 1) {
      throw new BadRequestException(
        'Un compromiso es de un solo cliente: esas ventas son de clientes distintos',
      );
    }
    const today = calendarDayCO(new Date());
    if (dto.dueOn < today) {
      throw new BadRequestException('La fecha del compromiso ya pasó');
    }
    const balance = sales.reduce((sum, sale) => sum + balanceOf(sale), 0);
    if (dto.amountCOP !== undefined && dto.amountCOP > balance) {
      throw new BadRequestException(
        `El saldo de esas ventas es ${formatCOP(balance)}: no se puede comprometer más`,
      );
    }

    const commitment = await this.prisma.$transaction(async (tx) => {
      // El anterior de estas ventas queda cancelado: manda el nuevo.
      const previous = await tx.retailPaymentCommitment.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          status: 'PENDING',
          saleIds: { hasSome: saleIds },
        },
        select: { id: true, saleIds: true, dueOn: true },
      });
      for (const row of previous) {
        await tx.retailPaymentCommitment.update({
          where: { id: row.id },
          data: { status: 'CANCELLED', cancelledAt: new Date() },
        });
      }

      const created = await tx.retailPaymentCommitment.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          customerId: sales[0].customerId,
          saleIds,
          dueOn: lotDate(dto.dueOn),
          amountCOP: dto.amountCOP ?? null,
          note: dto.note?.trim() || null,
          remindByWhatsapp: dto.remindByWhatsapp ?? true,
          remindDaysBefore: dto.remindDaysBefore ?? 1,
          message: dto.message?.trim() || null,
          userId: ctx.userId,
          userName: ctx.name,
        },
      });
      const replaced = previous.length
        ? ` (reemplaza el del ${formatDateCO(`${lotDay(previous[0].dueOn)}T12:00:00-05:00`)})`
        : '';
      await this.logEvent(tx, ctx, saleIds, {
        summary:
          `Compromiso de pago para el ${formatDay(dto.dueOn)}` +
          (dto.amountCOP
            ? ` por ${formatCOP(dto.amountCOP)}`
            : ' por el saldo') +
          replaced,
        note: dto.note?.trim() || null,
        detail: {
          commitmentId: created.id,
          dueOn: dto.dueOn,
          amountCOP: dto.amountCOP ?? null,
        },
      });
      return created;
    });
    return this.get(ctx, commitment.id);
  }

  /**
   * Los compromisos con su estado de hoy. `open` = los vigentes (pendientes e
   * incumplidos), que es lo que mira la bandeja de Por cobrar.
   */
  async list(
    ctx: TenantContext,
    filters: { open?: boolean; saleId?: string; customerId?: string } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const rows = await this.prisma.retailPaymentCommitment.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(filters.open ? { status: 'PENDING' } : {}),
        ...(filters.saleId ? { saleIds: { has: filters.saleId } } : {}),
        ...(filters.customerId ? { customerId: filters.customerId } : {}),
      },
      orderBy: { dueOn: 'asc' },
      take: 300,
    });
    const views = await this.toViews(ctx, rows);
    return filters.open
      ? views.filter(
          (view) => view.state === 'PENDING' || view.state === 'BROKEN',
        )
      : views;
  }

  async get(ctx: TenantContext, id: string) {
    const row = await this.find(ctx, id);
    return (await this.toViews(ctx, [row]))[0];
  }

  async update(
    ctx: TenantContext,
    id: string,
    dto: UpdatePaymentCommitmentDto,
  ) {
    const row = await this.find(ctx, id);
    if (row.status !== 'PENDING') {
      throw new BadRequestException('Este compromiso ya no está vigente');
    }
    if (dto.dueOn && dto.dueOn < calendarDayCO(new Date())) {
      throw new BadRequestException('La fecha del compromiso ya pasó');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.retailPaymentCommitment.update({
        where: { id },
        data: {
          ...(dto.dueOn ? { dueOn: lotDate(dto.dueOn), remindedAt: null } : {}),
          ...(dto.amountCOP !== undefined ? { amountCOP: dto.amountCOP } : {}),
          ...(dto.note !== undefined ? { note: dto.note?.trim() || null } : {}),
          ...(dto.remindByWhatsapp !== undefined
            ? { remindByWhatsapp: dto.remindByWhatsapp }
            : {}),
          ...(dto.remindDaysBefore !== undefined
            ? { remindDaysBefore: dto.remindDaysBefore }
            : {}),
          ...(dto.message !== undefined
            ? { message: dto.message?.trim() || null }
            : {}),
        },
      });
      if (dto.dueOn && dto.dueOn !== lotDay(row.dueOn)) {
        await this.logEvent(tx, ctx, row.saleIds, {
          summary: `Compromiso movido del ${formatDay(lotDay(row.dueOn))} al ${formatDay(dto.dueOn)}`,
          detail: { commitmentId: id, from: lotDay(row.dueOn), to: dto.dueOn },
        });
      }
    });
    return this.get(ctx, id);
  }

  async cancel(ctx: TenantContext, id: string) {
    const row = await this.find(ctx, id);
    if (row.status !== 'PENDING') {
      throw new BadRequestException('Este compromiso ya no está vigente');
    }
    await this.prisma.$transaction(async (tx) => {
      await tx.retailPaymentCommitment.update({
        where: { id },
        data: { status: 'CANCELLED', cancelledAt: new Date() },
      });
      await this.logEvent(tx, ctx, row.saleIds, {
        summary: `Se canceló el compromiso de pago del ${formatDay(lotDay(row.dueOn))}`,
        detail: { commitmentId: id },
      });
    });
    return this.get(ctx, id);
  }

  /** Se mandó el recordatorio. Lo llama la pantalla después de enviarlo. */
  async markReminded(ctx: TenantContext, id: string) {
    const row = await this.find(ctx, id);
    await this.prisma.$transaction(async (tx) => {
      await tx.retailPaymentCommitment.update({
        where: { id },
        data: { remindedAt: new Date() },
      });
      await this.logEvent(tx, ctx, row.saleIds, {
        summary: `Se le recordó por WhatsApp el pago del ${formatDay(lotDay(row.dueOn))}`,
        detail: { commitmentId: id },
      });
    });
    return this.get(ctx, id);
  }

  // ─── Interno ────────────────────────────────────────────────────────────────

  /**
   * Arma lo que ve la pantalla: estado de hoy, saldo, si toca recordar, y los
   * datos del cliente para el WhatsApp. Marca cumplidos los que ya lo están.
   */
  private async toViews(ctx: TenantContext, rows: RetailPaymentCommitment[]) {
    const saleIds = [...new Set(rows.flatMap((row) => row.saleIds))];
    const customerIds = [
      ...new Set(rows.map((row) => row.customerId).filter(Boolean)),
    ] as string[];
    const [sales, customers] = await Promise.all([
      this.prisma.retailSale.findMany({
        where: { id: { in: saleIds }, tenantId: ctx.tenantId },
        select: {
          id: true,
          code: true,
          status: true,
          totalCOP: true,
          paidCOP: true,
        },
      }),
      this.prisma.retailCustomer.findMany({
        where: { id: { in: customerIds }, tenantId: ctx.tenantId },
        select: { id: true, name: true, phone: true },
      }),
    ]);
    const saleById = new Map(sales.map((sale) => [sale.id, sale]));
    const customerById = new Map(customers.map((row) => [row.id, row]));
    const today = calendarDayCO(new Date());

    const views: Array<{ state: CommitmentState } & Record<string, unknown>> =
      [];
    for (const row of rows) {
      const own = row.saleIds
        .map((id) => saleById.get(id))
        .filter((sale): sale is NonNullable<typeof sale> => Boolean(sale));
      const balanceCOP = own
        .filter((sale) => sale.status !== 'VOIDED')
        .reduce((sum, sale) => sum + balanceOf(sale), 0);
      let status = row.status;
      // Se cumplió desde la última vez que alguien lo miró: se deja guardado.
      if (status === 'PENDING' && balanceCOP === 0) {
        status = 'FULFILLED';
        await this.prisma.retailPaymentCommitment.update({
          where: { id: row.id },
          data: { status: 'FULFILLED', fulfilledAt: new Date() },
        });
        await this.prisma.$transaction((tx) =>
          this.logEvent(tx, ctx, row.saleIds, {
            summary: `Se cumplió el compromiso de pago del ${formatDay(lotDay(row.dueOn))}`,
            detail: { commitmentId: row.id },
          }),
        );
      }
      const dueOn = lotDay(row.dueOn);
      const daysLeft = diffCalendarDaysCO(today, `${dueOn}T12:00:00-05:00`);
      const remindOn = addCalendarDaysCO(dueOn, -row.remindDaysBefore);
      const state: CommitmentState =
        status === 'PENDING' && daysLeft < 0 ? 'BROKEN' : status;
      const remindedDay = row.remindedAt ? calendarDayCO(row.remindedAt) : null;
      const customer = row.customerId ? customerById.get(row.customerId) : null;
      views.push({
        id: row.id,
        saleIds: row.saleIds,
        saleCodes: own.map((sale) => sale.code),
        customerId: row.customerId,
        customerName: customer?.name ?? null,
        customerPhone: customer?.phone ?? null,
        dueOn,
        daysLeft,
        amountCOP: row.amountCOP,
        // Lo que se espera que pague: lo pactado, sin pasar del saldo de hoy.
        expectedCOP:
          row.amountCOP !== null
            ? Math.min(row.amountCOP, balanceCOP)
            : balanceCOP,
        balanceCOP,
        note: row.note,
        message: row.message,
        remindByWhatsapp: row.remindByWhatsapp,
        remindDaysBefore: row.remindDaysBefore,
        remindOn,
        remindedAt: row.remindedAt,
        // Toca recordar: vigente, con recordatorio, ya llegó el día de
        // recordar, y no se le ha recordado desde ese día.
        remindToday:
          state !== 'FULFILLED' &&
          state !== 'CANCELLED' &&
          row.remindByWhatsapp &&
          today >= remindOn &&
          (remindedDay === null || remindedDay < remindOn),
        state,
        userName: row.userName,
        createdAt: row.createdAt,
      });
    }
    return views;
  }

  private async openSales(ctx: TenantContext, saleIds: string[]) {
    const sales = await this.prisma.retailSale.findMany({
      where: {
        id: { in: saleIds },
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: 'COMPLETED',
      },
      select: { id: true, customerId: true, totalCOP: true, paidCOP: true },
    });
    return sales.filter((sale) => balanceOf(sale) > 0);
  }

  private async find(ctx: TenantContext, id: string) {
    const row = await this.prisma.retailPaymentCommitment.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!row) throw new NotFoundException('Compromiso no encontrado');
    return row;
  }

  /** El mismo hecho en el histórico de cada venta del compromiso. */
  private async logEvent(
    tx: Tx,
    ctx: TenantContext,
    saleIds: string[],
    event: {
      summary: string;
      note?: string | null;
      detail?: Prisma.InputJsonValue;
    },
  ) {
    for (const saleId of saleIds) {
      await tx.retailSaleEvent.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          saleId,
          kind: 'COMMITMENT',
          summary: event.summary,
          note: event.note ?? null,
          ...(event.detail !== undefined ? { detail: event.detail } : {}),
          userId: ctx.userId,
          userName: ctx.name,
        },
      });
    }
  }
}

function balanceOf(sale: { totalCOP: number; paidCOP: number }) {
  return Math.max(0, sale.totalCOP - sale.paidCOP);
}

/** "2026-10-30" → "30/10/2026", sin pasar por la zona horaria. */
function formatDay(day: string) {
  return formatDateCO(`${day}T12:00:00-05:00`);
}
