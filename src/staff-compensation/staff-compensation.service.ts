import { Injectable, NotFoundException } from '@nestjs/common';
import { LedgerEntryType, Prisma, StaffLedgerEntry } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { UpsertCompensationDto } from './dto/compensation.dto';
import { UpsertRoleTemplateDto } from './dto/role-template.dto';
import {
  CreateLedgerEntryDto,
  LedgerQueryDto,
  UpdateLedgerEntryDto,
} from './dto/ledger.dto';

/** Movimientos de nómina que son salida de caja y por eso gasto. */
const EXPENSE_TYPES: LedgerEntryType[] = ['PAYMENT', 'ADVANCE'];
/** Movimientos que son salida de plata (llevan medio de pago). */
const DISBURSING_TYPES: LedgerEntryType[] = ['PAYMENT', 'ADVANCE', 'LOAN'];
const payrollExpenseId = (entryId: string) => `payexp_${entryId}`;

/** 'YYYY-MM-DD' se ancla al mediodía Colombia para no correr de día. */
function ledgerDate(value: string): Date {
  return /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? new Date(`${value}T12:00:00-05:00`)
    : new Date(value);
}

@Injectable()
export class StaffCompensationService {
  constructor(private readonly prisma: PrismaService) {}

  // ── Perfiles de compensación ────────────────────────────────────────────────
  getProfiles(ctx: TenantContext) {
    return this.prisma.staffCompensation.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { updatedAt: 'desc' },
    });
  }

  async getProfile(ctx: TenantContext, staffId: string) {
    const profile = await this.prisma.staffCompensation.findUnique({
      where: { tenantId_staffId: { tenantId: ctx.tenantId, staffId } },
    });
    if (!profile) throw new NotFoundException('Compensation profile not found');
    return profile;
  }

  upsertProfile(ctx: TenantContext, staffId: string, dto: UpsertCompensationDto) {
    const data = {
      source: dto.source,
      branchId: dto.branchId ?? ctx.branchId ?? null,
      contractType: dto.contractType,
      payFrequency: dto.payFrequency,
      baseAmount: dto.baseAmount,
      defaultBonuses: dto.defaultBonuses ?? null,
      hourlyRate: dto.hourlyRate ?? null,
      expectedHoursPerPeriod: dto.expectedHoursPerPeriod ?? null,
      commissionPercent: dto.commissionPercent ?? null,
      notes: dto.notes ?? null,
    };
    return this.prisma.staffCompensation.upsert({
      where: { tenantId_staffId: { tenantId: ctx.tenantId, staffId } },
      create: { tenantId: ctx.tenantId, staffId, ...data },
      update: data,
    });
  }

  // ── Plantillas por rol ──────────────────────────────────────────────────────
  getRoleTemplates(ctx: TenantContext) {
    return this.prisma.roleCompensationTemplate.findMany({
      where: { tenantId: ctx.tenantId },
    });
  }

  upsertRoleTemplate(ctx: TenantContext, role: string, dto: UpsertRoleTemplateDto) {
    const data = {
      contractType: dto.contractType,
      payFrequency: dto.payFrequency,
      baseAmount: dto.baseAmount,
      defaultBonuses: dto.defaultBonuses ?? null,
      hourlyRate: dto.hourlyRate ?? null,
      expectedHoursPerPeriod: dto.expectedHoursPerPeriod ?? null,
      commissionPercent: dto.commissionPercent ?? null,
    };
    return this.prisma.roleCompensationTemplate.upsert({
      where: { tenantId_role: { tenantId: ctx.tenantId, role } },
      create: { tenantId: ctx.tenantId, role, ...data },
      update: data,
    });
  }

  // ── Ledger ──────────────────────────────────────────────────────────────────
  getLedger(ctx: TenantContext, query: LedgerQueryDto) {
    return this.prisma.staffLedgerEntry.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(query.staffId ? { staffId: query.staffId } : {}),
        ...(query.period ? { period: query.period } : {}),
      },
      orderBy: { date: 'desc' },
    });
  }

  addLedgerEntry(ctx: TenantContext, dto: CreateLedgerEntryDto) {
    return this.prisma.$transaction(async (tx) => {
      const entry = await tx.staffLedgerEntry.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: dto.branchId ?? ctx.branchId ?? null,
          staffId: dto.staffId,
          staffName: dto.staffName,
          type: dto.type,
          amount: dto.amount,
          period: dto.period,
          method: dto.method ?? null,
          accountLabel: dto.accountLabel ?? null,
          coversFrom: dto.coversFrom ? new Date(dto.coversFrom) : null,
          coversTo: dto.coversTo ? new Date(dto.coversTo) : null,
          note: dto.note ?? null,
        },
      });
      await this.syncPayrollExpense(tx, ctx, entry);
      return entry;
    });
  }

  /**
   * Corregir un movimiento ya registrado (el valor, el mes, el medio, la nota).
   * El gasto ligado se reescribe con él: corregir el pago corrige Finanzas.
   */
  async updateLedgerEntry(ctx: TenantContext, id: string, dto: UpdateLedgerEntryDto) {
    return this.prisma.$transaction(async (tx) => {
      const current = await tx.staffLedgerEntry.findFirst({
        where: { id, tenantId: ctx.tenantId },
      });
      if (!current) throw new NotFoundException('Ledger entry not found');
      const type = dto.type ?? current.type;
      // Incentivo y descuento no tienen medio de pago: no salió plata.
      const disbursing = DISBURSING_TYPES.includes(type);
      const method =
        dto.method !== undefined ? dto.method : current.method;
      const entry = await tx.staffLedgerEntry.update({
        where: { id },
        data: {
          type,
          amount: dto.amount ?? current.amount,
          period: dto.period ?? current.period,
          method: disbursing ? (method ?? 'CASH') : null,
          accountLabel: disbursing
            ? dto.accountLabel !== undefined
              ? dto.accountLabel
              : current.accountLabel
            : null,
          note: dto.note !== undefined ? dto.note : current.note,
          ...(dto.date ? { date: ledgerDate(dto.date) } : {}),
        },
      });
      await this.syncPayrollExpense(tx, ctx, entry);
      return entry;
    });
  }

  async deleteLedgerEntry(ctx: TenantContext, id: string) {
    await this.prisma.$transaction(async (tx) => {
      // deleteMany con scope de tenant evita borrar de otros tenants.
      const res = await tx.staffLedgerEntry.deleteMany({
        where: { id, tenantId: ctx.tenantId },
      });
      if (res.count === 0) throw new NotFoundException('Ledger entry not found');
      await tx.expense.deleteMany({
        where: { id: payrollExpenseId(id), tenantId: ctx.tenantId },
      });
    });
  }

  /**
   * El pago de nómina ES un gasto: sale plata de la caja. Se escribe solo, con
   * id derivado (`payexp_<movimiento>`), así que es idempotente y se borra con
   * el movimiento. Mismo patrón que el flete de retail (`syncShippingExpense`).
   *
   * Solo PAGO y ADELANTO. El préstamo no es gasto (vuelve), y el incentivo y el
   * descuento mueven lo que se le debe, no la caja: la caja se mueve cuando se
   * le paga.
   */
  private async syncPayrollExpense(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    entry: StaffLedgerEntry,
  ) {
    const branchId = entry.branchId ?? ctx.branchId;
    const id = payrollExpenseId(entry.id);
    // Corregido a préstamo, incentivo o descuento: deja de ser gasto.
    if (!EXPENSE_TYPES.includes(entry.type) || !branchId) {
      await tx.expense.deleteMany({ where: { id, tenantId: entry.tenantId } });
      return;
    }
    const data = {
      tenantId: entry.tenantId,
      branchId,
      category: 'PAYROLL',
      concept: `Nómina ${entry.staffName} · ${entry.type === 'ADVANCE' ? 'adelanto' : 'pago'} ${entry.period}`,
      amountCOP: entry.amount,
      incurredAt: entry.date,
      sourceType: 'STAFF_LEDGER',
      sourceId: entry.id,
      note:
        [
          entry.method === 'TRANSFER' ? `Transferencia${entry.accountLabel ? ` ${entry.accountLabel}` : ''}` : 'Efectivo',
          entry.note,
        ]
          .filter(Boolean)
          .join(' · ') || null,
    };
    await tx.expense.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
  }

  // ── Lo ganado por comisión ──────────────────────────────────────────────────
  /**
   * Base de la comisión en el mes: los servicios que cada persona prestó y
   * quedaron completados, por el día en que se prestaron (no el agendado), con
   * el precio de la cita. Hasta hoy si el mes está en curso: es "lo que lleva
   * ganado". Hoy solo barbería/gimnasio tienen servicios con persona asignada;
   * las demás verticales devuelven vacío.
   */
  async getEarnings(ctx: TenantContext, period: string) {
    const [y, m] = period.split('-').map(Number);
    // Límites del mes en hora Colombia (UTC−5, sin horario de verano).
    const from = new Date(Date.UTC(y, m - 1, 1, 5));
    const to = new Date(Date.UTC(y, m, 1, 5));
    const appts = await this.prisma.barberAppointment.findMany({
      where: {
        tenantId: ctx.tenantId,
        ...(ctx.branchId ? { branchId: ctx.branchId } : {}),
        staffId: { not: null },
        status: { in: ['COMPLETED', 'completed'] },
        OR: [
          { servedAt: { gte: from, lt: to } },
          { servedAt: null, scheduledAt: { gte: from, lt: to } },
        ],
      },
      select: {
        staffId: true,
        priceCOP: true,
        service: { select: { priceCOP: true } },
      },
    });
    const byStaff = new Map<string, { servicesCount: number; salesCOP: number }>();
    for (const a of appts) {
      const row = byStaff.get(a.staffId!) ?? { servicesCount: 0, salesCOP: 0 };
      row.servicesCount += 1;
      row.salesCOP += a.priceCOP ?? a.service.priceCOP;
      byStaff.set(a.staffId!, row);
    }
    return [...byStaff].map(([staffId, row]) => ({ staffId, period, ...row }));
  }
}
