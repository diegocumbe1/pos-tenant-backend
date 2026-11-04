import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContext } from '../auth/types/tenant-context.interface';
import {
  addCalendarDaysCO,
  calendarDayCO,
  calendarMonthCO,
  dayEndCO,
  dayStartCO,
  formatCOP,
} from '../common/date.util';
import { PrismaService } from '../prisma/prisma.service';
import { CapitalService } from './capital.service';
import {
  CASH_SHORTAGE_CATEGORY,
  closingHints,
  computeChain,
  currentBalances,
  monthlyHistory,
  rowAccount,
  type ChainEntry,
  type ClosingAccount,
  type ClosingInput,
} from './cash-closing-calc';
import {
  AssignAccountDto,
  ClosingLineDto,
  ClosingPreviewDto,
  CreateClosingDto,
  CreateMoneyAccountDto,
  CreateTransferDto,
  UpdateMoneyAccountDto,
} from './dto/cash-closing.dto';
import { FinanceService } from './finance.service';

/** Mediodía Colombia: la fecha del movimiento nunca salta de día. */
function noonCO(day: string): Date {
  return new Date(dayStartCO(day).getTime() + 12 * 60 * 60 * 1000);
}

const SHORTAGE_SOURCE = 'CASH_CLOSING';
const PREVIEW_ID = '__preview__';

/**
 * Caja real: cuentas, cierres ("a esta fecha realmente tengo X") y traslados.
 * Docs: docs/PLAN_CAJA_REAL_CIERRES_Y_CUENTAS.md
 *
 * Lynko calcula lo esperado y la persona dice lo real. Nada de aquí ajusta un
 * saldo por su cuenta: una diferencia queda a la vista hasta que alguien la explica.
 */
@Injectable()
export class CashClosingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
    private readonly capital: CapitalService,
  ) {}

  // ─── Cuentas ───────────────────────────────────────────────────────────────

  /** Todo negocio arranca con dos: quien no quiere más no configura nada. */
  private async accounts(ctx: TenantContext) {
    const where = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const count = await this.prisma.moneyAccount.count({ where });
    if (count === 0) {
      await this.prisma.moneyAccount.createMany({
        data: [
          {
            ...where,
            name: 'Efectivo',
            type: 'CASH',
            defaultForMethods: ['CASH'],
            sortOrder: 0,
          },
          {
            ...where,
            name: 'Banco / Transferencias',
            type: 'BANK',
            defaultForMethods: ['TRANSFER', 'CARD', 'FINANCING', 'OTHER'],
            sortOrder: 1,
          },
        ],
        skipDuplicates: true,
      });
    }
    return this.prisma.moneyAccount.findMany({
      where,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  /** Un medio cae en una sola cuenta: asignarlo aquí lo quita de las demás. */
  private async claimMethods(
    ctx: TenantContext,
    accountId: string,
    methods: string[],
  ) {
    if (!methods.length) return;
    const others = await this.prisma.moneyAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        id: { not: accountId },
        defaultForMethods: { hasSome: methods },
      },
    });
    for (const other of others) {
      await this.prisma.moneyAccount.update({
        where: { id: other.id },
        data: {
          defaultForMethods: other.defaultForMethods.filter(
            (m) => !methods.includes(m),
          ),
        },
      });
    }
  }

  async createAccount(ctx: TenantContext, dto: CreateMoneyAccountDto) {
    const existing = await this.accounts(ctx);
    const name = dto.name.trim();
    if (existing.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      throw new ConflictException(`Ya tienes una cuenta llamada "${name}"`);
    }
    const account = await this.prisma.moneyAccount.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name,
        type: dto.type,
        defaultForMethods: dto.defaultForMethods ?? [],
        sortOrder: existing.length,
      },
    });
    await this.claimMethods(ctx, account.id, dto.defaultForMethods ?? []);
    return account;
  }

  async updateAccount(
    ctx: TenantContext,
    id: string,
    dto: UpdateMoneyAccountDto,
  ) {
    const accounts = await this.accounts(ctx);
    const account = accounts.find((a) => a.id === id);
    if (!account) throw new NotFoundException('Esa cuenta no existe');
    const name = dto.name?.trim();
    if (
      name &&
      accounts.some(
        (a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase(),
      )
    ) {
      throw new ConflictException(`Ya tienes una cuenta llamada "${name}"`);
    }
    if (dto.isActive === false && account.isActive) {
      if (accounts.filter((a) => a.isActive).length === 1) {
        throw new BadRequestException('Debe quedar al menos una cuenta activa');
      }
      // Con saldo, esa plata desaparecería del siguiente cierre sin explicación.
      const { chain, rows, transfers } = await this.loadChain(ctx, accounts);
      const balance = currentBalances(
        chain[chain.length - 1] ?? null,
        rows,
        transfers,
        accounts,
      )?.balances.get(id);
      if (balance) {
        throw new BadRequestException(
          `Esa cuenta tiene ${formatCOP(balance)}: trasládalos a otra antes de desactivarla`,
        );
      }
    }
    const updated = await this.prisma.moneyAccount.update({
      where: { id },
      data: {
        name,
        type: dto.type,
        defaultForMethods: dto.defaultForMethods,
        isActive: dto.isActive,
      },
    });
    if (dto.defaultForMethods) {
      await this.claimMethods(ctx, id, dto.defaultForMethods);
    }
    return updated;
  }

  // ─── Lectura ───────────────────────────────────────────────────────────────

  private async loadChain(
    ctx: TenantContext,
    accounts: ClosingAccount[],
    closings?: ClosingInput[],
  ) {
    const vertical = await this.finance.tenantVertical(ctx);
    const tomorrow = dayEndCO(addCalendarDaysCO(calendarDayCO(new Date()), 1));
    const [rows, transferRows, inputs] = await Promise.all([
      this.finance.baseCashMovements(ctx, vertical, null, tomorrow),
      this.prisma.moneyTransfer.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
        },
        orderBy: { occurredAt: 'desc' },
      }),
      closings ?? this.finance.closingInputs(ctx),
    ]);
    return {
      rows,
      transfers: transferRows,
      chain: computeChain(inputs, rows, transferRows, accounts),
    };
  }

  /** Lo que falta decir: movimientos posteriores al corte sin cuenta. */
  private unassigned(
    chain: ChainEntry[],
    rows: Awaited<ReturnType<CashClosingsService['loadChain']>>['rows'],
    accounts: ClosingAccount[],
  ) {
    if (!chain.length) return [];
    const firstDay = chain[0].day;
    return rows
      .filter(
        (r) =>
          calendarDayCO(r.at) > firstDay &&
          !r.outsideBusiness &&
          !rowAccount(r, accounts),
      )
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map((r) => ({
        origin: r.origin,
        refId: r.refId ?? null,
        day: calendarDayCO(r.at),
        category: r.category,
        label: r.label ?? null,
        method: r.method ?? null,
        direction: r.direction,
        amountCOP: r.amountCOP,
      }));
  }

  private assumedByClosing(ctx: TenantContext) {
    return this.prisma.expense
      .findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          sourceType: SHORTAGE_SOURCE,
        },
        select: { sourceId: true, amountCOP: true },
      })
      .then(
        (rows) =>
          new Map(rows.map((r) => [r.sourceId ?? '', r.amountCOP] as const)),
      );
  }

  private entryDto(entry: ChainEntry, assumed: Map<string, number>) {
    return {
      id: entry.id,
      day: entry.day,
      previousDay: entry.previousDay,
      isFirst: entry.isFirst,
      countedTotalCOP: entry.countedTotalCOP,
      expectedTotalCOP: entry.expectedTotalCOP,
      differenceCOP: entry.differenceCOP,
      expectedAtCloseCOP: entry.expectedAtCloseCOP,
      differenceAtCloseCOP: entry.differenceAtCloseCOP,
      collectedCOP: entry.collectedCOP,
      unassignedNetCOP: entry.unassignedNetCOP,
      assumedCOP: assumed.get(entry.id) ?? 0,
      lines: entry.lines,
    };
  }

  /** Todo lo que necesita la pestaña Caja, de una vez. */
  async overview(ctx: TenantContext) {
    const accounts = await this.accounts(ctx);
    const { chain, rows, transfers } = await this.loadChain(ctx, accounts);
    const last = chain[chain.length - 1] ?? null;
    const assumed = await this.assumedByClosing(ctx);
    const now = currentBalances(last, rows, transfers, accounts);
    const closings = await this.prisma.cashClosing.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      select: { id: true, note: true, createdAt: true },
    });
    const meta = new Map(closings.map((c) => [c.id, c]));
    const calculatedCOP = rows.reduce(
      (s, r) => s + (r.direction === 'IN' ? r.amountCOP : -r.amountCOP),
      0,
    );
    const unexplainedCOP = chain.reduce((s, e) => s + e.differenceCOP, 0);
    const names = new Map(accounts.map((a) => [a.id, a.name]));

    return {
      today: calendarDayCO(new Date()),
      verified: chain.length > 0,
      lastClosingDay: last?.day ?? null,
      /** Lo que dice Lynko sin contar nada. */
      calculatedCashCOP: calculatedCOP,
      /** Lo calculado + las diferencias: lo contado más lo que se movió después. */
      cashCOP: calculatedCOP + unexplainedCOP,
      unexplainedCOP,
      unassignedNetCOP: now?.unassignedNetCOP ?? 0,
      accounts: accounts.map((a) => ({
        id: a.id,
        name: a.name,
        type: a.type,
        defaultForMethods: a.defaultForMethods,
        isActive: a.isActive,
        balanceCOP: now?.balances.get(a.id) ?? null,
      })),
      closings: [...chain].reverse().map((entry) => ({
        ...this.entryDto(entry, assumed),
        note: meta.get(entry.id)?.note ?? null,
        createdAt: meta.get(entry.id)?.createdAt.toISOString() ?? null,
      })),
      history: monthlyHistory(chain, assumed, calendarMonthCO()),
      unassigned: this.unassigned(chain, rows, accounts),
      transfers: transfers.slice(0, 50).map((t) => ({
        id: t.id,
        day: calendarDayCO(t.occurredAt),
        fromAccountId: t.fromAccountId,
        fromName: names.get(t.fromAccountId) ?? '',
        toAccountId: t.toAccountId,
        toName: names.get(t.toAccountId) ?? '',
        amountCOP: t.amountCOP,
        note: t.note,
      })),
    };
  }

  /** Las causas probables y de qué se compone lo esperado de un cierre. */
  private async explain(
    ctx: TenantContext,
    chain: ChainEntry[],
    entry: ChainEntry,
    accounts: ClosingAccount[],
  ) {
    const [summary, templates] = await Promise.all([
      this.capital.summary(ctx),
      this.prisma.expenseTemplate.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
          isActive: true,
        },
        select: { concept: true, amountCOP: true },
      }),
    ]);
    const composition = new Map<
      string,
      { category: string; direction: string; amountCOP: number; count: number }
    >();
    for (const row of entry.rows) {
      const key = `${row.direction}|${row.category}`;
      const item = composition.get(key) ?? {
        category: row.category,
        direction: row.direction,
        amountCOP: 0,
        count: 0,
      };
      item.amountCOP += row.amountCOP;
      item.count += 1;
      composition.set(key, item);
    }
    return {
      hints: closingHints({
        entry,
        accounts,
        pendingSuggestedCOP: summary.invested.pendingSuggestedCOP,
        templates,
        previous: chain.slice(0, chain.indexOf(entry)),
        formatCOP,
      }),
      composition: [...composition.values()].sort(
        (a, b) => b.amountCOP - a.amountCOP,
      ),
      movements: entry.rows
        .filter((r) => r.origin !== 'SALES')
        .sort((a, b) => b.at.getTime() - a.at.getTime())
        .slice(0, 50)
        .map((r) => ({
          day: calendarDayCO(r.at),
          category: r.category,
          label: r.label ?? null,
          direction: r.direction,
          amountCOP: r.amountCOP,
        })),
    };
  }

  // ─── Cierres ───────────────────────────────────────────────────────────────

  private resolveDay(day?: string) {
    const today = calendarDayCO(new Date());
    const resolved = day ?? today;
    if (resolved > today) {
      throw new BadRequestException(
        'No se puede cerrar un día que no ha llegado',
      );
    }
    return resolved;
  }

  /** Se cuentan TODAS las cuentas activas: si no, la diferencia no dice nada. */
  private assertLines(accounts: ClosingAccount[], lines: ClosingLineDto[]) {
    const ids = new Set(lines.map((l) => l.accountId));
    if (ids.size !== lines.length) {
      throw new BadRequestException('Una cuenta aparece dos veces');
    }
    for (const line of lines) {
      if (!accounts.some((a) => a.id === line.accountId)) {
        throw new BadRequestException('Esa cuenta no existe');
      }
    }
  }

  /** Arma el cierre sin guardarlo, entre los que ya existen. */
  private async simulate(
    ctx: TenantContext,
    day: string,
    lines: ClosingLineDto[],
  ) {
    const accounts = await this.accounts(ctx);
    this.assertLines(accounts, lines);
    const missing = accounts.filter(
      (a) => a.isActive && !lines.some((l) => l.accountId === a.id),
    );
    if (missing.length) {
      throw new BadRequestException(
        `Falta escribir cuánto hay en: ${missing.map((a) => a.name).join(', ')}`,
      );
    }
    const existing = await this.finance.closingInputs(ctx);
    const replaced = existing.find((c) => c.day === day);
    const inputs: ClosingInput[] = [
      ...existing.filter((c) => c.day !== day),
      {
        id: PREVIEW_ID,
        day,
        expectedTotalCOP: 0,
        lines: lines.map((l) => ({
          accountId: l.accountId,
          countedCOP: l.countedCOP,
          expectedSnapshotCOP: null,
        })),
      },
    ];
    const { chain } = await this.loadChain(ctx, accounts, inputs);
    const entry = chain.find((e) => e.id === PREVIEW_ID)!;
    return { accounts, chain, entry, replaced };
  }

  /** "Revisar": muestra si cuadra y qué pudo pasar, sin guardar nada. */
  async preview(ctx: TenantContext, dto: ClosingPreviewDto) {
    const day = this.resolveDay(dto.day);
    const { accounts, chain, entry, replaced } = await this.simulate(
      ctx,
      day,
      dto.lines,
    );
    return {
      ...this.entryDto(entry, new Map()),
      replacesExisting: !!replaced,
      ...(await this.explain(ctx, chain, entry, accounts)),
    };
  }

  async create(ctx: TenantContext, dto: CreateClosingDto) {
    const day = this.resolveDay(dto.day);
    const { entry, replaced } = await this.simulate(ctx, day, dto.lines);
    if (replaced && !dto.replace) {
      throw new ConflictException(`Ya hay un cierre del ${day}`);
    }
    const created = await this.prisma.$transaction(async (tx) => {
      if (replaced) {
        await tx.cashClosing.update({
          where: { id: replaced.id },
          data: { deletedAt: new Date() },
        });
        // El faltante asumido queda colgado del cierre nuevo.
      }
      const closing = await tx.cashClosing.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          day,
          expectedTotalCOP: entry.expectedTotalCOP,
          countedTotalCOP: entry.countedTotalCOP,
          note: dto.note?.trim() || null,
          userId: ctx.userId,
          lines: {
            create: entry.lines.map((l) => ({
              accountId: l.accountId,
              countedCOP: l.countedCOP,
              expectedSnapshotCOP: l.expectedCOP,
            })),
          },
        },
      });
      if (replaced) {
        await tx.expense.updateMany({
          where: {
            tenantId: ctx.tenantId,
            sourceType: SHORTAGE_SOURCE,
            sourceId: replaced.id,
          },
          data: { sourceId: closing.id },
        });
      }
      return closing;
    });
    return this.detail(ctx, created.id);
  }

  async detail(ctx: TenantContext, id: string) {
    const accounts = await this.accounts(ctx);
    const { chain } = await this.loadChain(ctx, accounts);
    const entry = chain.find((e) => e.id === id);
    if (!entry) throw new NotFoundException('Ese cierre no existe');
    const assumed = await this.assumedByClosing(ctx);
    return {
      ...this.entryDto(entry, assumed),
      ...(await this.explain(ctx, chain, entry, accounts)),
    };
  }

  /** Soft-delete. Los cierres vecinos se recalculan solos. */
  async remove(ctx: TenantContext, id: string) {
    const closing = await this.prisma.cashClosing.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
    });
    if (!closing) throw new NotFoundException('Ese cierre no existe');
    await this.prisma.$transaction([
      this.prisma.cashClosing.update({
        where: { id },
        data: { deletedAt: new Date() },
      }),
      // El gasto "Faltante de caja" solo existía por este cierre.
      this.prisma.expense.deleteMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          sourceType: SHORTAGE_SOURCE,
          sourceId: id,
        },
      }),
    ]);
    return { ok: true };
  }

  /**
   * "Nunca apareció": el faltante pasa a ser un gasto y baja la ganancia. Con eso
   * la diferencia queda en cero, pero el histórico lo sigue contando como pérdida.
   */
  async assumeShortage(ctx: TenantContext, id: string) {
    const accounts = await this.accounts(ctx);
    const { chain } = await this.loadChain(ctx, accounts);
    const entry = chain.find((e) => e.id === id);
    if (!entry) throw new NotFoundException('Ese cierre no existe');
    if (entry.differenceCOP >= 0) {
      throw new BadRequestException('Ese cierre no tiene faltante por asumir');
    }
    // Por origen y no por id: si el cierre se reemplazó, el gasto ya viene del
    // cierre anterior y hay que sumarle, no crear otro.
    const already = await this.prisma.expense.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        sourceType: SHORTAGE_SOURCE,
        sourceId: id,
      },
      select: { id: true, amountCOP: true },
    });
    const expenseId = already?.id ?? `cashshort_${id}`;
    const amountCOP = (already?.amountCOP ?? 0) - entry.differenceCOP;
    const data = {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      category: CASH_SHORTAGE_CATEGORY,
      concept: `Faltante de caja del ${entry.day}`,
      amountCOP,
      incurredAt: noonCO(entry.day),
      sourceType: SHORTAGE_SOURCE,
      sourceId: id,
      // Esa plata no salió de una cuenta: desapareció. Cuenta en el total, y no
      // debe pedir que alguien diga de cuál salió.
      paidOutsideBusiness: true,
    };
    await this.prisma.expense.upsert({
      where: { id: expenseId },
      create: { id: expenseId, ...data },
      update: data,
    });
    return this.detail(ctx, id);
  }

  /** Decir de qué cuenta salió algo que se quedó sin cuenta. */
  async assign(ctx: TenantContext, dto: AssignAccountDto) {
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };
    const account = await this.prisma.moneyAccount.findFirst({
      where: { id: dto.moneyAccountId, ...scope },
      select: { id: true },
    });
    if (!account) throw new BadRequestException('Esa cuenta no existe');
    const data = {
      moneyAccountId: dto.moneyAccountId,
      paidOutsideBusiness: null,
    };
    const { count } =
      dto.origin === 'EXPENSE'
        ? await this.prisma.expense.updateMany({
            where: { id: dto.refId, ...scope },
            data,
          })
        : await this.prisma.capitalMovement.updateMany({
            where: { id: dto.refId, deletedAt: null, ...scope },
            data,
          });
    if (!count) throw new NotFoundException('Ese movimiento no existe');
    return { ok: true };
  }

  // ─── Traslados ─────────────────────────────────────────────────────────────

  async createTransfer(ctx: TenantContext, dto: CreateTransferDto) {
    if (dto.fromAccountId === dto.toAccountId) {
      throw new BadRequestException('Elige dos cuentas distintas');
    }
    const found = await this.prisma.moneyAccount.count({
      where: {
        id: { in: [dto.fromAccountId, dto.toAccountId] },
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
    });
    if (found !== 2) throw new BadRequestException('Esa cuenta no existe');
    return this.prisma.moneyTransfer.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        fromAccountId: dto.fromAccountId,
        toAccountId: dto.toAccountId,
        amountCOP: dto.amountCOP,
        occurredAt: noonCO(dto.occurredOn),
        note: dto.note?.trim() || null,
        userId: ctx.userId,
      },
    });
  }

  async removeTransfer(ctx: TenantContext, id: string) {
    const { count } = await this.prisma.moneyTransfer.updateMany({
      where: {
        id,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
    });
    if (!count) throw new NotFoundException('Ese traslado no existe');
    return { ok: true };
  }
}
