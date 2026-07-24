import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CashMovement,
  CashMovementType,
  CashSession,
  CashSessionStatus,
} from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { dayStartCO, dayEndCO } from '../../../common/date.util';
import { PrintingDocumentService } from '../printing/printing-document.service';
import {
  CloseCashSessionDto,
  CreateCashMovementDto,
  OpenCashSessionDto,
} from './dto/cash-session.dto';

/** Signo de cada tipo de movimiento sobre el efectivo esperado. */
const SIGN: Record<CashMovementType, 1 | -1> = {
  OPENING: 1,
  SALE: 1,
  DEPOSIT: 1,
  TIP: 1,
  ADJUSTMENT: 1,
  REFUND: -1,
  EXPENSE: -1,
  WITHDRAWAL: -1,
};

export interface RecordSaleParams {
  tenantId: string;
  branchId: string;
  terminalId?: string | null;
  createdByUserId: string;
  contributions: Array<{ method: string; amount: number }>;
  reference?: string;
}

@Injectable()
export class CashSessionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: PrintingDocumentService,
  ) {}

  async open(ctx: TenantContext, dto: OpenCashSessionDto) {
    const existing = await this.findOpen(
      ctx.tenantId,
      ctx.branchId,
      dto.terminalId,
    );
    if (existing)
      throw new ConflictException({
        code: 'CASH_SESSION_ALREADY_OPEN',
        message: `Terminal ${dto.terminalId} already has an open session`,
      });

    const session = await this.prisma.cashSession.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        terminalId: dto.terminalId,
        openedByUserId: ctx.userId,
        openingAmount: dto.openingAmount,
        openingNote: dto.openingNote,
        movements: {
          create: {
            type: CashMovementType.OPENING,
            method: 'cash',
            amount: dto.openingAmount,
            createdByUserId: ctx.userId,
            note: 'Base inicial',
          },
        },
      },
      include: { movements: true },
    });
    return this.map(session);
  }

  async close(ctx: TenantContext, id: string, dto: CloseCashSessionDto) {
    const session = await this.assertSession(ctx, id);
    if (session.status === CashSessionStatus.CLOSED)
      throw new ConflictException('Cash session already closed');

    const movements = await this.prisma.cashMovement.findMany({
      where: { sessionId: id },
    });
    const expectedAmount = this.expectedCash(movements);
    const difference = dto.countedAmount - expectedAmount;

    const closed = await this.prisma.cashSession.update({
      where: { id },
      data: {
        status: CashSessionStatus.CLOSED,
        closedAt: new Date(),
        closedByUserId: ctx.userId,
        expectedAmount,
        countedAmount: dto.countedAmount,
        difference,
        closingNote: dto.closingNote,
      },
      include: { movements: true },
    });
    return this.map(closed);
  }

  async current(ctx: TenantContext, terminalId?: string) {
    const session = await this.findOpen(ctx.tenantId, ctx.branchId, terminalId);
    if (!session) return { session: null };
    const full = await this.prisma.cashSession.findUnique({
      where: { id: session.id },
      include: { movements: true },
    });
    return { session: this.map(full!) };
  }

  async list(ctx: TenantContext, from?: string, to?: string) {
    const sessions = await this.prisma.cashSession.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(from || to
          ? {
              openedAt: {
                ...(from ? { gte: dayStartCO(from) } : {}),
                ...(to ? { lte: dayEndCO(to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { openedAt: 'desc' },
    });
    return { sessions: sessions.map((s) => this.map(s)) };
  }

  async findOne(ctx: TenantContext, id: string) {
    const session = await this.prisma.cashSession.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { movements: { orderBy: { createdAt: 'asc' } } },
    });
    if (!session) throw new NotFoundException(`Cash session ${id} not found`);
    return this.map(session);
  }

  async movements(ctx: TenantContext, id: string) {
    await this.assertSession(ctx, id);
    const movements = await this.prisma.cashMovement.findMany({
      where: { sessionId: id },
      orderBy: { createdAt: 'asc' },
    });
    return { movements: movements.map((m) => this.mapMovement(m)) };
  }

  async addMovement(ctx: TenantContext, id: string, dto: CreateCashMovementDto) {
    const session = await this.assertSession(ctx, id);
    if (session.status === CashSessionStatus.CLOSED)
      throw new UnprocessableEntityException(
        'Cannot add movements to a closed session',
      );
    const movement = await this.prisma.cashMovement.create({
      data: {
        sessionId: id,
        type: dto.type,
        method: dto.method,
        amount: dto.amount,
        reference: dto.reference,
        note: dto.note,
        createdByUserId: ctx.userId,
      },
    });
    return this.mapMovement(movement);
  }

  async summary(ctx: TenantContext, id: string) {
    await this.assertSession(ctx, id);
    const movements = await this.prisma.cashMovement.findMany({
      where: { sessionId: id },
    });
    return this.buildSummary(movements);
  }

  /** Documento Z (cierre de caja) re-renderizable. Requiere sesión cerrada. */
  async report(ctx: TenantContext, id: string) {
    const session = await this.prisma.cashSession.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { movements: true, tenant: { select: { name: true } } },
    });
    if (!session) throw new NotFoundException(`Cash session ${id} not found`);

    const summary = this.buildSummary(session.movements);
    const counts = {
      sales: session.movements.filter((m) => m.type === CashMovementType.SALE).length,
      refunds: session.movements.filter((m) => m.type === CashMovementType.REFUND).length,
      other: session.movements.filter(
        (m) =>
          m.type !== CashMovementType.SALE && m.type !== CashMovementType.REFUND,
      ).length,
    };

    const document = this.docs.buildZReport({
      sessionId: session.id,
      terminalId: session.terminalId,
      businessName: session.tenant?.name ?? null,
      openedAt: session.openedAt,
      closedAt: session.closedAt ?? new Date(),
      openingAmount: session.openingAmount,
      expectedAmount: session.expectedAmount ?? this.expectedCash(session.movements),
      countedAmount: session.countedAmount ?? 0,
      difference: session.difference ?? 0,
      totalsByMethod: summary.byMethod.map((b) => ({ method: b.method, total: b.total })),
      movementCounts: counts,
    });
    return { document, summary };
  }

  // ─── Integración con cierre de orden ─────────────────────────────────────
  /** Devuelve la sesión OPEN para (tenant, branch[, terminal]) o null. */
  async findOpen(tenantId: string, branchId: string, terminalId?: string | null) {
    return this.prisma.cashSession.findFirst({
      where: {
        tenantId,
        branchId,
        status: CashSessionStatus.OPEN,
        ...(terminalId ? { terminalId } : {}),
      },
      orderBy: { openedAt: 'desc' },
    });
  }

  /**
   * Registra una venta como movimientos de caja (uno por contribución).
   * Best-effort: si no hay sesión abierta devuelve null (el cierre de orden
   * decide si eso es un error duro o no).
   */
  async recordSale(params: RecordSaleParams): Promise<string | null> {
    const session = await this.findOpen(
      params.tenantId,
      params.branchId,
      params.terminalId,
    );
    if (!session) return null;

    await this.prisma.cashMovement.createMany({
      data: params.contributions.map((c) => ({
        sessionId: session.id,
        type: CashMovementType.SALE,
        method: c.method,
        amount: c.amount,
        reference: params.reference,
        createdByUserId: params.createdByUserId,
      })),
    });
    return session.id;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────
  private expectedCash(movements: Array<{ type: CashMovementType; method: string; amount: number }>) {
    return movements
      .filter((m) => m.method === 'cash')
      .reduce((sum, m) => sum + SIGN[m.type] * m.amount, 0);
  }

  /** CashSessionSummary del contrato FE (Anexo A §A4). */
  private buildSummary(
    movements: Array<{ type: CashMovementType; method: string; amount: number }>,
  ) {
    const byMethod = new Map<string, { total: number; count: number }>();
    const byType = new Map<string, { total: number; count: number }>();
    let totalSales = 0;
    let totalRefunds = 0;
    let totalExpenses = 0;
    for (const m of movements) {
      const bm = byMethod.get(m.method) ?? { total: 0, count: 0 };
      bm.total += m.amount;
      bm.count += 1;
      byMethod.set(m.method, bm);
      const bt = byType.get(m.type) ?? { total: 0, count: 0 };
      bt.total += m.amount;
      bt.count += 1;
      byType.set(m.type, bt);
      if (m.type === CashMovementType.SALE) totalSales += m.amount;
      if (m.type === CashMovementType.REFUND) totalRefunds += m.amount;
      if (m.type === CashMovementType.EXPENSE) totalExpenses += m.amount;
    }
    return {
      byMethod: [...byMethod].map(([method, v]) => ({ method, total: v.total, count: v.count })),
      byType: [...byType].map(([type, v]) => ({ type, total: v.total, count: v.count })),
      totalSales,
      totalRefunds,
      totalExpenses,
    };
  }

  private async assertSession(ctx: TenantContext, id: string) {
    const session = await this.prisma.cashSession.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!session) throw new NotFoundException(`Cash session ${id} not found`);
    return session;
  }

  private map(session: CashSession & { movements?: CashMovement[] }) {
    return {
      ...session,
      openedAt: session.openedAt.toISOString(),
      closedAt: session.closedAt?.toISOString() ?? null,
      movements: session.movements?.map((m) => this.mapMovement(m)) ?? [],
    };
  }

  private mapMovement(m: CashMovement) {
    return { ...m, createdAt: m.createdAt.toISOString() };
  }
}
