import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { UpsertCompensationDto } from './dto/compensation.dto';
import { UpsertRoleTemplateDto } from './dto/role-template.dto';
import { CreateLedgerEntryDto, LedgerQueryDto } from './dto/ledger.dto';

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
    return this.prisma.staffLedgerEntry.create({
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
  }

  async deleteLedgerEntry(ctx: TenantContext, id: string) {
    // deleteMany con scope de tenant evita borrar de otros tenants.
    const res = await this.prisma.staffLedgerEntry.deleteMany({
      where: { id, tenantId: ctx.tenantId },
    });
    if (res.count === 0) throw new NotFoundException('Ledger entry not found');
  }
}
