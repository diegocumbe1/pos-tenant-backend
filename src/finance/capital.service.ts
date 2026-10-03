import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { CapitalMovement, CapitalMovementKind, Prisma } from '@prisma/client';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  addCalendarDaysCO,
  calendarDayCO,
  dayEndCO,
  dayStartCO,
} from '../common/date.util';
import { FinanceService } from './finance.service';
import { runCascade } from './capital-cascade';
import { resolveNature } from './expense-nature';
import { bucketForCategory } from './expense-buckets';
import {
  CreateCapitalMovementDto,
  UpdateCapitalMovementDto,
} from './dto/capital.dto';
import { PeriodQueryDto } from './dto/period-query.dto';

const CONTRIBUTIONS: CapitalMovementKind[] = [
  'INITIAL_CONTRIBUTION',
  'CONTRIBUTION',
];
/** Solo a lo que el dueño mete (o presta) le aplica "¿de dónde salió?". */
const FUNDED: CapitalMovementKind[] = [...CONTRIBUTIONS, 'LOAN_IN'];
/** Plata que el dueño saca del negocio (no es gasto). */
const WITHDRAWALS: CapitalMovementKind[] = [
  'PROFIT_WITHDRAWAL',
  'CAPITAL_RETURN',
  'OWNER_WITHDRAWAL',
];

const WITH_ALLOCATIONS = {
  allocations: {
    include: {
      expense: {
        select: { id: true, concept: true, amountCOP: true, incurredAt: true },
      },
    },
  },
} satisfies Prisma.CapitalMovementInclude;

type MovementWithAllocations = Prisma.CapitalMovementGetPayload<{
  include: typeof WITH_ALLOCATIONS;
}>;

/** Mediodía Colombia: la fecha del movimiento nunca salta de día. */
function noonCO(day: string): Date {
  return new Date(dayStartCO(day).getTime() + 12 * 60 * 60 * 1000);
}

/** Cuánto pesa al mes un gasto recurrente (para la reserva de operación). */
function monthlyEquivalent(amount: number, frequency: string): number {
  switch (frequency) {
    case 'DAILY':
      return amount * 30;
    case 'WEEKLY':
      return Math.round((amount * 52) / 12);
    case 'BIWEEKLY':
      return amount * 2;
    case 'ANNUAL':
      return Math.round(amount / 12);
    default:
      return amount;
  }
}

/** Los aportes con plata prestada se pueden abonar; los ahorros no se deben. */
function isRepayable(m: CapitalMovement): boolean {
  if (m.kind === 'LOAN_IN') return true;
  if (!CONTRIBUTIONS.includes(m.kind) || m.inKind) return false;
  if (m.source === 'REPLENISHMENT') return false;
  return !!m.fundingSource && m.fundingSource !== 'SAVINGS';
}

/**
 * Cuánto se ha abonado a cada préstamo y cuánto falta.
 *
 * Los abonos registrados antes de poder ligarlos a un préstamo
 * (`repaysMovementId` NULL) se aplican a los préstamos del negocio en orden de
 * fecha: así cuentan igual que antes y no se pierden.
 */
export function loanLedger(capital: CapitalMovement[]) {
  const loans = capital
    .filter(isRepayable)
    .sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  const repayments = capital.filter((m) => m.kind === 'LOAN_REPAYMENT');
  const repaid = new Map<string, number>();
  const byLoan = new Map<string, CapitalMovement[]>();
  let unlinked = 0;
  for (const r of repayments) {
    if (r.repaysMovementId) {
      repaid.set(
        r.repaysMovementId,
        (repaid.get(r.repaysMovementId) ?? 0) + r.amountCOP,
      );
      byLoan.set(r.repaysMovementId, [
        ...(byLoan.get(r.repaysMovementId) ?? []),
        r,
      ]);
    } else unlinked += r.amountCOP;
  }
  for (const loan of loans.filter((l) => l.kind === 'LOAN_IN')) {
    if (unlinked <= 0) break;
    const room = loan.amountCOP - (repaid.get(loan.id) ?? 0);
    const use = Math.min(room, unlinked);
    repaid.set(loan.id, (repaid.get(loan.id) ?? 0) + use);
    unlinked -= use;
  }
  const outstanding = (m: CapitalMovement) =>
    Math.max(0, m.amountCOP - (repaid.get(m.id) ?? 0));
  return {
    loans,
    repaidOf: (id: string) => repaid.get(id) ?? 0,
    outstandingOf: outstanding,
    repaymentsOf: (id: string) => byLoan.get(id) ?? [],
    businessOutstandingCOP: loans
      .filter((l) => l.kind === 'LOAN_IN')
      .reduce((s, l) => s + outstanding(l), 0),
    personalOutstandingCOP: loans
      .filter((l) => l.kind !== 'LOAN_IN')
      .reduce((s, l) => s + outstanding(l), 0),
    /** Lo abonado con plata del negocio (NULL cuenta como del negocio). */
    repaidFromBusinessCOP: repayments
      .filter((r) => r.paidFromBusiness !== false)
      .reduce((s, r) => s + r.amountCOP, 0),
    /**
     * Lo que se pidió prestado a nombre del dueño para el negocio. Es deuda
     * (se resta como préstamo por pagar), así que NO es plata propia.
     */
    personalPrincipalCOP: loans
      .filter((l) => l.kind !== 'LOAN_IN')
      .reduce((s, l) => s + l.amountCOP, 0),
    /** Lo abonado de su bolsillo: la deuda pasa a ser plata propia del dueño. */
    repaidFromPocketCOP: repayments
      .filter((r) => r.paidFromBusiness === false)
      .reduce((s, r) => s + r.amountCOP, 0),
  };
}

/**
 * La pestaña Inversión: cuánto puso el dueño, cuánto se reinvirtió, cuánto ya
 * recuperó, dónde está su plata y cuánto puede sacar.
 *
 * Todo se calcula sobre las MISMAS filas de plata del flujo de caja
 * (`FinanceService.cashMovements`): si cada pantalla armara las suyas, la caja
 * de Inversión y la de Flujo de caja no cuadrarían.
 *
 * Definiciones: docs/PLAN_INVERSION_RETORNO_Y_FLUJO_REAL.md §2 y §5.
 */
@Injectable()
export class CapitalService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly finance: FinanceService,
  ) {}

  // ─── Movimientos (CRUD) ────────────────────────────────────────────────────

  async list(ctx: TenantContext) {
    const rows = await this.prisma.capitalMovement.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
      include: WITH_ALLOCATIONS,
    });
    return rows.map((row) => this.toDto(row));
  }

  async create(ctx: TenantContext, dto: CreateCapitalMovementDto) {
    if (dto.kind === 'LOAN_REPAYMENT' && dto.repaysMovementId) {
      await this.assertRepayment(ctx, dto.repaysMovementId, dto.amountCOP);
    }
    const movement = await this.prisma.$transaction(async (tx) => {
      const created = await tx.capitalMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          userId: ctx.userId,
          ...this.data(dto.kind, dto),
          kind: dto.kind,
          amountCOP: dto.amountCOP,
          occurredAt: noonCO(dto.occurredOn),
          source: dto.source ?? 'MANUAL',
        },
      });
      if (dto.allocations?.length) {
        await this.replaceAllocations(
          tx,
          ctx,
          created.id,
          dto.kind,
          dto.amountCOP,
          dto.allocations,
        );
      }
      return tx.capitalMovement.findUniqueOrThrow({
        where: { id: created.id },
        include: WITH_ALLOCATIONS,
      });
    });
    return this.toDto(movement);
  }

  async update(ctx: TenantContext, id: string, dto: UpdateCapitalMovementDto) {
    const current = await this.assertOwn(ctx, id);
    const kind = dto.kind ?? current.kind;
    const amount = dto.amountCOP ?? current.amountCOP;
    const repays = dto.repaysMovementId ?? current.repaysMovementId;
    if (kind === 'LOAN_REPAYMENT' && repays) {
      await this.assertRepayment(ctx, repays, amount, id);
    }
    const movement = await this.prisma.$transaction(async (tx) => {
      await tx.capitalMovement.update({
        where: { id },
        data: {
          ...this.data(kind, dto),
          kind,
          amountCOP: dto.amountCOP,
          occurredAt: dto.occurredOn ? noonCO(dto.occurredOn) : undefined,
        },
      });
      // Cambiar a un tipo que no se vincula (un retiro) borra los vínculos.
      if (dto.allocations !== undefined || !FUNDED.includes(kind)) {
        await this.replaceAllocations(
          tx,
          ctx,
          id,
          kind,
          amount,
          FUNDED.includes(kind) ? (dto.allocations ?? []) : [],
        );
      } else {
        // Si solo bajó el monto, los vínculos no pueden quedar por encima.
        const linked = await tx.capitalAllocation.aggregate({
          where: { capitalMovementId: id },
          _sum: { amountCOP: true },
        });
        if ((linked._sum.amountCOP ?? 0) > amount) {
          throw new BadRequestException(
            'El valor quedó por debajo de lo que ya está vinculado a gastos: ajusta los vínculos',
          );
        }
      }
      return tx.capitalMovement.findUniqueOrThrow({
        where: { id },
        include: WITH_ALLOCATIONS,
      });
    });
    return this.toDto(movement);
  }

  /** Soft-delete: el histórico de lo que se registró no desaparece. */
  async remove(ctx: TenantContext, id: string) {
    await this.assertOwn(ctx, id);
    await this.prisma.capitalMovement.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  // ─── Resumen ───────────────────────────────────────────────────────────────

  async summary(ctx: TenantContext) {
    const vertical = await this.finance.tenantVertical(ctx);
    const tomorrow = dayEndCO(addCalendarDaysCO(calendarDayCO(new Date()), 1));
    const [movements, capital, allocations, declared] = await Promise.all([
      this.finance.cashMovements(ctx, vertical, null, tomorrow),
      this.prisma.capitalMovement.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
        },
      }),
      this.prisma.capitalAllocation.findMany({
        where: {
          tenantId: ctx.tenantId,
          capitalMovement: { branchId: ctx.branchId, deletedAt: null },
        },
        select: { capitalMovementId: true, expenseId: true, amountCOP: true },
      }),
      this.prisma.expense.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          fundedFromSalesCOP: { gt: 0 },
        },
        select: { id: true, fundedFromSalesCOP: true },
      }),
    ]);
    const expenseConcepts = new Map(
      movements
        .filter((m) => m.origin === 'EXPENSE' && m.refId)
        .map((m) => [m.refId!, m.label ?? '']),
    );

    const cascade = runCascade(
      movements,
      allocations.map((a) => ({
        movementId: a.capitalMovementId,
        expenseId: a.expenseId,
        amountCOP: a.amountCOP,
      })),
      new Map(declared.map((e) => [e.id, e.fundedFromSalesCOP ?? 0])),
    );
    const firstAt = movements.reduce<Date | null>(
      (min, row) => (!min || row.at < min ? row.at : min),
      null,
    );

    // ── Lo que puso el dueño ──
    // Una REPOSICIÓN es plata que el dueño devuelve al negocio después de haber
    // sacado de más: entra a la caja, pero no es inversión nueva — solo salda
    // lo que se había llevado.
    const replenishments = capital.filter(
      (m) => CONTRIBUTIONS.includes(m.kind) && m.source === 'REPLENISHMENT',
    );
    const replenishedCOP = replenishments.reduce((s, m) => s + m.amountCOP, 0);
    const contributions = capital.filter(
      (m) => CONTRIBUTIONS.includes(m.kind) && m.source !== 'REPLENISHMENT',
    );
    const confirmedCOP = contributions.reduce((s, m) => s + m.amountCOP, 0);
    const initial = contributions.filter(
      (m) => m.kind === 'INITIAL_CONTRIBUTION',
    );
    const sumKind = (kind: CapitalMovementKind) =>
      capital
        .filter((m) => m.kind === kind)
        .reduce((s, m) => s + m.amountCOP, 0);
    // "Saqué plata del negocio" (OWNER_WITHDRAWAL) se clasifica solo: lo que
    // cabe en la ganancia es retiro de ganancias, lo que se pasa es devolverse
    // capital. El dueño no tiene por qué saber la diferencia para anotarlo.
    const withdrawnCOP = WITHDRAWALS.reduce((s, k) => s + sumKind(k), 0);
    const loanInCOP = sumKind('LOAN_IN');
    const ledger = loanLedger(capital);
    // Lo que se debe: préstamos del negocio y préstamos a nombre del dueño que
    // financiaron el negocio. Los dos hay que pagarlos.
    const loanOutstandingCOP =
      ledger.businessOutstandingCOP + ledger.personalOutstandingCOP;

    // Los faltantes de caja que nadie ha explicado cuentan como inversión
    // SUGERIDA: alguien puso esa plata. Se muestran aparte para que el dueño
    // los confirme (y diga de dónde salió).
    const pendingSuggestedCOP = cascade.suggestions.reduce(
      (s, x) => s + x.amountCOP,
      0,
    );
    // INVERTIDO = todo lo que NO salió de ventas ni de ganancias: lo propio
    // (ahorros, préstamos a nombre del dueño, socio…) y también los préstamos
    // a nombre del negocio. Antes los préstamos del negocio quedaban por fuera
    // y el total mostraba solo una parte de lo que de verdad se metió.
    const ownCOP = confirmedCOP + pendingSuggestedCOP;
    const investedCOP = ownCOP + loanInCOP;

    // ── Ganancia real (todo el histórico) y ritmo reciente ──
    const today = calendarDayCO(new Date());
    const [allTime, last90] = await Promise.all([
      firstAt
        ? this.finance.dashboard(ctx, {
            period: 'custom',
            dateFrom: firstAt.getTime(),
            dateTo: tomorrow.getTime(),
          } as PeriodQueryDto)
        : null,
      this.finance.dashboard(ctx, {
        period: 'custom',
        dateFrom: dayStartCO(addCalendarDaysCO(today, -89)).getTime(),
        dateTo: dayEndCO(today).getTime(),
      } as PeriodQueryDto),
    ]);
    const profitCOP = allTime?.netProfitCOP ?? 0;
    // LO QUE EL DUEÑO SE LLEVÓ. De lo sacado, la parte que cabe en la ganancia
    // estaba bien sacarla; lo que se pasa NO era ganancia: era la plata de la
    // mercancía vendida, la que tenía que volver para pagar deudas o recomprar.
    // Eso queda POR REPONER — antes se restaba en silencio de "lo que pusiste" y
    // el dueño no veía que se había llevado plata que no era ganancia.
    const ownerTakenCOP =
      sumKind('PROFIT_WITHDRAWAL') + sumKind('OWNER_WITHDRAWAL');
    const profitWithdrawnCOP = Math.min(Math.max(0, profitCOP), ownerTakenCOP);
    const overProfitCOP = ownerTakenCOP - profitWithdrawnCOP;
    const toReplenishCOP = Math.max(0, overProfitCOP - replenishedCOP);
    // Solo una "Devolución de capital" explícita baja lo invertido.
    const capitalReturnedCOP = sumKind('CAPITAL_RETURN');
    // Lo que el NEGOCIO ya le devolvió a los prestamistas deja de estar
    // invertido: salió del negocio. Si lo pagó el dueño de su bolsillo, la
    // inversión sigue ahí (ahora es plata suya en vez de prestada).
    const investedNetCOP = Math.max(
      0,
      investedCOP - capitalReturnedCOP - ledger.repaidFromBusinessCOP,
    );
    const byPurpose = new Map<string, number>();
    for (const m of capital) {
      if (m.kind !== 'OWNER_WITHDRAWAL' && m.kind !== 'PROFIT_WITHDRAWAL')
        continue;
      const key = m.purpose ?? 'UNSPECIFIED';
      byPurpose.set(key, (byPurpose.get(key) ?? 0) + m.amountCOP);
    }
    const monthlyProfitCOP = Math.round((last90.netProfitCOP ?? 0) / 3);

    // ── Dónde está la plata ──
    // La caja asume que lo sugerido sí se puso: es la misma suposición que
    // cuenta lo sugerido como inversión, y las dos cifras tienen que cuadrar.
    const rawCashCOP = movements.reduce(
      (s, r) => s + (r.direction === 'IN' ? r.amountCOP : -r.amountCOP),
      0,
    );
    const cashCOP = rawCashCOP + pendingSuggestedCOP;
    const assets = await this.assets(ctx, vertical);
    // Lo que TIENE el negocio (antes de las deudas por préstamos): se compara
    // contra todo lo invertido, préstamos incluidos. Lo que queda para el dueño
    // es eso menos lo que se debe.
    const businessAssetsCOP =
      cashCOP +
      (assets.inventoryCOP ?? 0) +
      (assets.receivablesCOP ?? 0) -
      (assets.customerAdvancesCOP ?? 0) -
      (assets.supplierDebtCOP ?? 0);
    const netWorthCOP = businessAssetsCOP - loanOutstandingCOP;

    // ── La ganancia vista desde lo que el negocio TIENE ──
    // Lo que queda para el dueño = lo propio que puso + lo que ganó el negocio
    // − lo que ya se sacó. Despejando: lo que ganó solo = lo que queda − lo
    // propio + lo sacado. Tiene que dar lo mismo que la ganancia por resultados
    // (ventas − costo − gastos); si no da, la diferencia es un dato por
    // corregir (ventas sin costo, inventario mal valorizado, un retiro o un
    // aporte sin registrar). Es el cuadre que le da confianza al número.
    // Lo propio es solo lo que es del dueño: lo prestado a su nombre ya se
    // resta como deuda, contarlo aquí también lo descontaría dos veces. Lo que
    // abonó de su bolsillo sí pasa a ser suyo.
    const ownCapitalCOP =
      ownCOP -
      ledger.personalPrincipalCOP +
      ledger.repaidFromPocketCOP -
      capitalReturnedCOP;
    const takenNetCOP = ownerTakenCOP - replenishedCOP;
    const balanceProfitCOP = netWorthCOP - ownCapitalCOP + takenNetCOP;

    // ── De dónde salió lo invertido, desglosado ──
    const breakdown = this.investedBreakdown(
      capital,
      allocations,
      expenseConcepts,
      pendingSuggestedCOP,
      ledger,
    );

    // ── Recuperación ──
    const recoveredCOP = Math.max(0, Math.min(profitCOP, investedNetCOP));
    const remainingCOP = Math.max(0, investedNetCOP - Math.max(0, profitCOP));
    const pct = (part: number, whole: number) =>
      whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;

    // ── Cuánto se puede sacar ──
    const templates = await this.prisma.expenseTemplate.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        isActive: true,
      },
      select: {
        amountCOP: true,
        frequency: true,
        category: true,
        nature: true,
      },
    });
    const reserveCOP = templates
      .filter((t) => resolveNature(t.category, t.nature) === 'FIXED')
      .reduce((s, t) => s + monthlyEquivalent(t.amountCOP, t.frequency), 0);
    const freeCashCOP = Math.max(
      0,
      cashCOP - (assets.supplierDebtCOP ?? 0) - reserveCOP,
    );
    const profitAvailableCOP = Math.max(0, profitCOP - profitWithdrawnCOP);
    const withdrawableProfitCOP = Math.min(freeCashCOP, profitAvailableCOP);

    const byFunding = new Map<string, number>();
    for (const m of contributions) {
      const key = m.fundingSource ?? 'UNSPECIFIED';
      byFunding.set(key, (byFunding.get(key) ?? 0) + m.amountCOP);
    }

    return {
      firstMovementAt: firstAt ? firstAt.toISOString() : null,
      invested: {
        totalCOP: investedCOP,
        confirmedCOP,
        pendingSuggestedCOP,
        initialCOP: initial.reduce((s, m) => s + m.amountCOP, 0),
        hasInitial: initial.length > 0,
        inKindCOP: contributions
          .filter((m) => m.inKind)
          .reduce((s, m) => s + m.amountCOP, 0),
        byFundingSource: [...byFunding.entries()].map(
          ([source, amountCOP]) => ({
            source,
            amountCOP,
          }),
        ),
        capitalReturnedCOP,
        netCOP: investedNetCOP,
        /** Plata propia (incluye préstamos a nombre del dueño) + por explicar. */
        ownCOP,
        /** Préstamos a nombre del negocio. */
        businessLoansCOP: loanInCOP,
        /** Por origen, con cada movimiento y a qué compras fue. */
        breakdown,
      },
      money: {
        /** Cobrado en ventas, neto de devoluciones. */
        salesCollectedCOP: cascade.salesInCOP - cascade.refundsCOP,
        /** Todo lo pagado en gastos (incluye compras de mercancía). */
        spentCOP: cascade.spentCOP,
        /** De eso: compras de mercancía (y su flete). */
        purchasesCOP: cascade.expenses
          .filter((e) => bucketForCategory(e.category) === 'supplies')
          .reduce((s, e) => s + e.amountCOP, 0),
        /** De eso: todo lo demás (arriendo, nómina, servicios…). */
        otherExpensesCOP: cascade.expenses
          .filter((e) => bucketForCategory(e.category) !== 'supplies')
          .reduce((s, e) => s + e.amountCOP, 0),
        /** Plata que el dueño sacó del negocio, de cualquier tipo. */
        withdrawnCOP,
        /** Pagado con plata que dejaron las ventas. */
        reinvestedCOP: cascade.fromSalesCOP,
        /** Pagado con plata que puso el dueño (confirmada o sugerida). */
        fromOwnerCOP: cascade.fromCapitalCOP + pendingSuggestedCOP,
        reinvestedPct: pct(cascade.fromSalesCOP, cascade.spentCOP),
      },
      profit: {
        /** Ventas − costo de lo vendido − gastos de operación, todo el histórico. */
        totalCOP: profitCOP,
        revenueCOP: allTime?.revenue ?? 0,
        cogsCOP: allTime?.cogsCOP ?? 0,
        /** Ventas sin costo cargado: la ganancia sale inflada en esa parte. */
        uncostedRevenueCOP: allTime?.uncostedRevenueCOP ?? 0,
        withdrawnCOP: profitWithdrawnCOP,
        /** Promedio de los últimos 90 días, por mes. */
        monthlyAverageCOP: monthlyProfitCOP,
      },
      recovery: {
        recoveredCOP,
        recoveredPct: pct(recoveredCOP, investedNetCOP),
        remainingCOP,
        remainingPct: pct(remainingCOP, investedNetCOP),
        /** Meses que faltan al ritmo reciente. null = no se puede estimar. */
        monthsToRecover:
          remainingCOP > 0 && monthlyProfitCOP > 0
            ? Math.ceil(remainingCOP / monthlyProfitCOP)
            : remainingCOP === 0
              ? 0
              : null,
      },
      backing: {
        cashCOP,
        /** Caja sin suponer los aportes sugeridos (lo que Lynko sabe hoy). */
        rawCashCOP,
        inventoryCOP: assets.inventoryCOP,
        /** Lo ENTREGADO que falta cobrar. Lo no entregado ya está en inventario. */
        receivablesCOP: assets.receivablesCOP,
        /** Cobrado por mercancía aún sin entregar: está en caja y en inventario. */
        customerAdvancesCOP: assets.customerAdvancesCOP,
        supplierDebtCOP: assets.supplierDebtCOP,
        loanOutstandingCOP,
        netWorthCOP,
        /** Plata propia del dueño en el negocio (incluye préstamos que ya pagó de su bolsillo). */
        ownCapitalCOP,
        /** Lo sacado por el dueño, neto de lo que ya repuso. */
        takenNetCOP,
        /** Ganancia según lo que el negocio tiene: lo que queda − lo propio + lo sacado. */
        balanceProfitCOP,
        /** balanceProfit − ganancia por resultados. 0 = los números cuadran. */
        profitGapCOP: balanceProfitCOP - profitCOP,
        /** Lo que tiene el negocio antes de restar préstamos. */
        businessAssetsCOP,
        backingPct: pct(businessAssetsCOP, investedNetCOP),
        cashPct: pct(Math.max(0, cashCOP), investedNetCOP),
      },
      withdrawable: {
        reserveCOP,
        freeCashCOP,
        profitAvailableCOP,
        /** Lo que se puede sacar SIN tocar el capital ni la operación. */
        withdrawableProfitCOP,
      },
      /** Lo que el dueño ha sacado y cuánto de eso debería volver. */
      withdrawals: {
        totalCOP: withdrawnCOP,
        /** Sacado como ganancia (o sin decir): lo que se compara con la ganancia. */
        ownerTakenCOP,
        /** De eso, lo que sí era ganancia. */
        asProfitCOP: profitWithdrawnCOP,
        /** De eso, lo que se pasó de la ganancia. */
        overProfitCOP,
        /** Lo que ya se devolvió al negocio. */
        replenishedCOP,
        /** Lo que falta devolver. */
        toReplenishCOP,
        byPurpose: [...byPurpose.entries()].map(([purpose, amountCOP]) => ({
          purpose,
          amountCOP,
        })),
      },
      suggestions: cascade.suggestions,
      /**
       * Cómo se pagó CADA gasto: con ventas, con plata del dueño (la vinculada
       * y la general) y lo que falta explicar. Los más recientes primero.
       */
      expenses: cascade.expenses
        .map((e) => ({
          ...e,
          isPurchase: bucketForCategory(e.category) === 'supplies',
          status:
            e.missingCOP > 0 ? ('MISSING' as const) : ('COVERED' as const),
        }))
        .reverse()
        .slice(0, 200),
    };
  }

  /**
   * El dueño dice cuánto de un gasto pagó con plata de las ventas (reinversión).
   * 0 lo quita. No puede pasar lo que el gasto vale menos lo ya vinculado a
   * aportes: un mismo peso no se explica dos veces.
   */
  async setExpenseFunding(
    ctx: TenantContext,
    expenseId: string,
    fromSalesCOP: number,
  ) {
    const expense = await this.prisma.expense.findFirst({
      where: { id: expenseId, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: {
        id: true,
        concept: true,
        amountCOP: true,
        capitalAllocations: {
          where: { capitalMovement: { deletedAt: null } },
          select: { amountCOP: true },
        },
      },
    });
    if (!expense) throw new NotFoundException(`Expense ${expenseId} not found`);
    const linked = expense.capitalAllocations.reduce(
      (s, a) => s + a.amountCOP,
      0,
    );
    if (fromSalesCOP + linked > expense.amountCOP) {
      throw new BadRequestException(
        `"${expense.concept}" vale ${expense.amountCOP} y ya tiene ${linked} explicados con aportes: de ventas caben máximo ${expense.amountCOP - linked}`,
      );
    }
    await this.prisma.expense.update({
      where: { id: expenseId },
      data: { fundedFromSalesCOP: fromSalesCOP > 0 ? fromSalesCOP : null },
    });
    return { expenseId, fromSalesCOP };
  }

  // ─── Interno ───────────────────────────────────────────────────────────────

  /**
   * Lo invertido por origen: cada aporte o préstamo con su fecha, su nota
   * ("uso TC Paola") y las compras para las que fue. Es lo que el dueño usa
   * para coordinar qué tiene que cubrir con quién.
   */
  private investedBreakdown(
    capital: CapitalMovement[],
    allocations: Array<{
      capitalMovementId: string;
      expenseId: string;
      amountCOP: number;
    }>,
    expenseConcepts: Map<string, string>,
    pendingSuggestedCOP: number,
    ledger: ReturnType<typeof loanLedger>,
  ) {
    type Group = {
      origin: string;
      totalCOP: number;
      /** Solo préstamos: abonado y por pagar. */
      repaidCOP: number | null;
      outstandingCOP: number | null;
      items: Array<{
        movementId: string;
        kind: CapitalMovementKind;
        date: string;
        amountCOP: number;
        /** Si se puede abonar (es préstamo, no ahorro). */
        repayable: boolean;
        repaidCOP: number;
        outstandingCOP: number;
        repayments: Array<{
          id: string;
          date: string;
          amountCOP: number;
          paidFromBusiness: boolean;
          note: string | null;
        }>;
        note: string | null;
        interestRatePct: number | null;
        interestPeriod: string | null;
        expenses: Array<{ concept: string; amountCOP: number }>;
      }>;
    };
    const groups = new Map<string, Group>();
    for (const m of capital) {
      const isLoan = m.kind === 'LOAN_IN';
      const isOwn =
        CONTRIBUTIONS.includes(m.kind) && m.source !== 'REPLENISHMENT';
      if (!isLoan && !isOwn) continue;
      const origin = isLoan
        ? 'BUSINESS_LOAN'
        : m.inKind
          ? 'IN_KIND'
          : (m.fundingSource ?? 'UNSPECIFIED');
      const group = groups.get(origin) ?? {
        origin,
        totalCOP: 0,
        repaidCOP: null,
        outstandingCOP: null,
        items: [],
      };
      group.totalCOP += m.amountCOP;
      const repayable = isRepayable(m);
      if (repayable) {
        group.repaidCOP = (group.repaidCOP ?? 0) + ledger.repaidOf(m.id);
        group.outstandingCOP =
          (group.outstandingCOP ?? 0) + ledger.outstandingOf(m);
      }
      group.items.push({
        movementId: m.id,
        kind: m.kind,
        date: calendarDayCO(m.occurredAt),
        amountCOP: m.amountCOP,
        repayable,
        repaidCOP: repayable ? ledger.repaidOf(m.id) : 0,
        outstandingCOP: repayable ? ledger.outstandingOf(m) : 0,
        repayments: ledger.repaymentsOf(m.id).map((r) => ({
          id: r.id,
          date: calendarDayCO(r.occurredAt),
          amountCOP: r.amountCOP,
          paidFromBusiness: r.paidFromBusiness !== false,
          note: r.note,
        })),
        note: m.fundingNote ?? m.note,
        interestRatePct:
          m.interestRateBps !== null ? m.interestRateBps / 100 : null,
        interestPeriod: m.interestPeriod,
        expenses: allocations
          .filter((a) => a.capitalMovementId === m.id)
          .map((a) => ({
            concept: expenseConcepts.get(a.expenseId) ?? 'Gasto',
            amountCOP: a.amountCOP,
          })),
      });
      groups.set(origin, group);
    }
    if (pendingSuggestedCOP > 0) {
      groups.set('PENDING', {
        origin: 'PENDING',
        totalCOP: pendingSuggestedCOP,
        repaidCOP: null,
        outstandingCOP: null,
        items: [],
      });
    }
    return [...groups.values()]
      .map((g) => ({
        ...g,
        items: g.items.sort((a, b) => a.date.localeCompare(b.date)),
      }))
      .sort((a, b) => b.totalCOP - a.totalCOP);
  }

  /**
   * Lo que el negocio tiene además de la caja. Hoy solo la tienda lleva
   * inventario valorizado, cuentas por cobrar y libro de proveedores; en las
   * otras verticales va null ("no se sabe"), nunca 0 ("no hay").
   */
  private async assets(ctx: TenantContext, vertical: string) {
    if (vertical !== 'retail') {
      return {
        inventoryCOP: null,
        receivablesCOP: null,
        customerAdvancesCOP: null,
        supplierDebtCOP: null,
      };
    }
    const [products, openSales, ledger] = await Promise.all([
      this.prisma.retailProduct.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
          stock: { gt: 0 },
        },
        select: { stock: true, avgCostCOP: true, costCOP: true },
      }),
      // Ventas que no están cerradas del todo: con saldo por cobrar o con
      // mercancía por entregar. Las dos cosas se cruzan con el inventario.
      this.prisma.retailSale.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          status: 'COMPLETED',
          OR: [
            { paymentStatus: { not: 'PAID' } },
            { deliveryStatus: 'PENDING' },
          ],
        },
        select: {
          totalCOP: true,
          paidCOP: true,
          deliveryStatus: true,
          items: {
            select: { totalCOP: true, quantity: true, deliveredQty: true },
          },
        },
      }),
      this.prisma.retailSupplierLedgerEntry.groupBy({
        by: ['supplierId'],
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
        _sum: { amountCOP: true },
      }),
    ]);
    // LA MERCANCÍA NO SE CUENTA DOS VECES. Una venta con entrega pendiente no
    // descuenta el inventario hasta que se entrega (`deliverInTransaction`),
    // así que esa mercancía ya está sumada en el inventario. Por venta:
    //   entregado = lo que ya salió (toda la venta si está DELIVERED; si no,
    //               la parte de cada línea según `deliveredQty`).
    //   · Te deben  = lo entregado que no se ha cobrado.
    //   · Anticipos = lo cobrado por mercancía que todavía no se entrega: esa
    //                 plata está en la caja Y la mercancía en el inventario, y
    //                 no es del negocio hasta entregar. Resta.
    let receivablesCOP = 0;
    let customerAdvancesCOP = 0;
    for (const sale of openSales) {
      const deliveredCOP =
        sale.deliveryStatus === 'DELIVERED'
          ? sale.totalCOP
          : sale.items.reduce(
              (sum, item) =>
                sum +
                (item.quantity > 0
                  ? Math.round(
                      (item.totalCOP * item.deliveredQty) / item.quantity,
                    )
                  : 0),
              0,
            );
      receivablesCOP += Math.max(0, deliveredCOP - sale.paidCOP);
      customerAdvancesCOP += Math.max(0, sale.paidCOP - deliveredCOP);
    }

    return {
      inventoryCOP: products.reduce(
        (s, p) => s + p.stock * (p.avgCostCOP ?? p.costCOP),
        0,
      ),
      receivablesCOP,
      customerAdvancesCOP,
      // Solo lo que se le DEBE a cada proveedor; lo que ellos deben no es caja.
      supplierDebtCOP: ledger.reduce(
        (s, row) => s + Math.max(0, row._sum.amountCOP ?? 0),
        0,
      ),
    };
  }

  /** Los campos que dependen del tipo: origen solo para aportes y préstamos. */
  private data(kind: CapitalMovementKind, dto: UpdateCapitalMovementDto) {
    const funded = FUNDED.includes(kind);
    if (dto.inKind && !CONTRIBUTIONS.includes(kind)) {
      throw new BadRequestException('Solo un aporte puede ser en mercancía');
    }
    return {
      inKind: CONTRIBUTIONS.includes(kind) ? dto.inKind : false,
      fundingSource: funded ? dto.fundingSource : null,
      fundingNote: funded
        ? dto.fundingNote !== undefined
          ? dto.fundingNote.trim() || null
          : undefined
        : null,
      interestRateBps: funded
        ? dto.interestRatePct !== undefined
          ? Math.round(dto.interestRatePct * 100)
          : undefined
        : null,
      interestPeriod: funded ? dto.interestPeriod : null,
      purpose: WITHDRAWALS.includes(kind) ? dto.purpose : null,
      repaysMovementId: kind === 'LOAN_REPAYMENT' ? dto.repaysMovementId : null,
      paidFromBusiness: kind === 'LOAN_REPAYMENT' ? dto.paidFromBusiness : null,
      note: dto.note !== undefined ? dto.note.trim() || null : undefined,
    };
  }

  /**
   * Reemplaza los vínculos de un aporte con sus gastos.
   *
   * Validaciones: solo aportes y préstamos se vinculan; los gastos tienen que
   * ser de la misma sede; lo vinculado no puede pasar el valor del aporte, ni
   * —sumado a lo que otros aportes ya vincularon— el valor de cada gasto.
   */
  private async replaceAllocations(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    movementId: string,
    kind: CapitalMovementKind,
    amountCOP: number,
    allocations: Array<{ expenseId: string; amountCOP: number }>,
  ) {
    if (allocations.length && !FUNDED.includes(kind)) {
      throw new BadRequestException(
        'Solo un aporte o un préstamo se puede vincular a gastos',
      );
    }
    const ids = [...new Set(allocations.map((a) => a.expenseId))];
    if (ids.length !== allocations.length) {
      throw new BadRequestException(
        'Un gasto aparece dos veces en los vínculos',
      );
    }
    const total = allocations.reduce((s, a) => s + a.amountCOP, 0);
    if (total > amountCOP) {
      throw new BadRequestException(
        'Lo vinculado a gastos supera el valor del aporte',
      );
    }

    const expenses = ids.length
      ? await tx.expense.findMany({
          where: {
            id: { in: ids },
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
          },
          select: {
            id: true,
            concept: true,
            amountCOP: true,
            fundedFromSalesCOP: true,
            capitalAllocations: {
              where: {
                capitalMovementId: { not: movementId },
                capitalMovement: { deletedAt: null },
              },
              select: { amountCOP: true },
            },
          },
        })
      : [];
    if (expenses.length !== ids.length) {
      throw new NotFoundException('Uno de los gastos no existe en esta sede');
    }
    const byId = new Map(expenses.map((e) => [e.id, e]));
    for (const a of allocations) {
      const expense = byId.get(a.expenseId)!;
      const others = expense.capitalAllocations.reduce(
        (s, x) => s + x.amountCOP,
        0,
      );
      // Lo declarado como "salió de ventas" también ocupa valor del gasto.
      const fromSales = expense.fundedFromSalesCOP ?? 0;
      if (others + fromSales + a.amountCOP > expense.amountCOP) {
        throw new BadRequestException(
          `"${expense.concept}" vale ${expense.amountCOP} y ya tiene ${others + fromSales} explicados: no caben ${a.amountCOP} más`,
        );
      }
    }

    await tx.capitalAllocation.deleteMany({
      where: { capitalMovementId: movementId },
    });
    if (allocations.length) {
      await tx.capitalAllocation.createMany({
        data: allocations.map((a) => ({
          tenantId: ctx.tenantId,
          capitalMovementId: movementId,
          expenseId: a.expenseId,
          amountCOP: a.amountCOP,
        })),
      });
    }
  }

  /**
   * Un abono tiene que ser a un préstamo de esta sede, que se pueda abonar, y
   * no puede pasar lo que falta (sin contar este mismo abono si se edita).
   */
  private async assertRepayment(
    ctx: TenantContext,
    loanId: string,
    amountCOP: number,
    excludeId?: string,
  ) {
    const capital = await this.prisma.capitalMovement.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
    });
    const loan = capital.find((m) => m.id === loanId);
    if (!loan || !isRepayable(loan)) {
      throw new BadRequestException(
        'Ese movimiento no es un préstamo que se pueda abonar',
      );
    }
    const ledger = loanLedger(capital.filter((m) => m.id !== excludeId));
    const outstanding = ledger.outstandingOf(loan);
    if (amountCOP > outstanding) {
      throw new BadRequestException(
        `A ese préstamo le faltan ${outstanding}: no se pueden abonar ${amountCOP}`,
      );
    }
  }

  private async assertOwn(ctx: TenantContext, id: string) {
    const row = await this.prisma.capitalMovement.findFirst({
      where: {
        id,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
    });
    if (!row) throw new NotFoundException(`Capital movement ${id} not found`);
    return row;
  }

  private toDto(m: CapitalMovement | MovementWithAllocations) {
    return {
      id: m.id,
      kind: m.kind,
      amountCOP: m.amountCOP,
      inKind: m.inKind,
      occurredOn: calendarDayCO(m.occurredAt),
      fundingSource: m.fundingSource,
      fundingNote: m.fundingNote,
      interestRatePct:
        m.interestRateBps !== null ? m.interestRateBps / 100 : null,
      interestPeriod: m.interestPeriod,
      purpose: m.purpose,
      repaysMovementId: m.repaysMovementId,
      paidFromBusiness: m.paidFromBusiness,
      source: m.source,
      note: m.note,
      createdAt: m.createdAt.toISOString(),
      /** A qué gasto(s) corresponde, con su nombre para mostrarlo. */
      allocations:
        'allocations' in m
          ? m.allocations.map((a) => ({
              expenseId: a.expenseId,
              amountCOP: a.amountCOP,
              concept: a.expense.concept,
              expenseAmountCOP: a.expense.amountCOP,
              expenseDate: calendarDayCO(a.expense.incurredAt),
            }))
          : [],
    };
  }
}
