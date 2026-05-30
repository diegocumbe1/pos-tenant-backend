import { BadRequestException, Injectable } from '@nestjs/common';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberStaffDto,
  UpdateBarberStaffDto,
} from './dto/barber-staff.dto';

@Injectable()
export class BarberStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async listStaff(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberStaff.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { services: { include: { service: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createStaff(ctx: TenantContext, dto: CreateBarberStaffDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    await this.assertServicesBelongToBranch(ctx, dto.serviceIds ?? []);
    return this.prisma.barberStaff.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        avatarUrl: dto.avatarUrl,
        color: dto.color,
        bio: dto.bio,
        sortOrder: dto.sortOrder,
        services: dto.serviceIds
          ? { create: dto.serviceIds.map((serviceId) => ({ serviceId })) }
          : undefined,
      },
      include: { services: { include: { service: true } } },
    });
  }

  async updateStaff(ctx: TenantContext, id: string, dto: UpdateBarberStaffDto) {
    await this.tenantHelper.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    await this.assertServicesBelongToBranch(ctx, dto.serviceIds ?? []);

    return this.prisma.$transaction(async (tx) => {
      const staff = await tx.barberStaff.update({
        where: { id },
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          avatarUrl: dto.avatarUrl,
          color: dto.color,
          bio: dto.bio,
          isActive: dto.isActive,
          sortOrder: dto.sortOrder,
        },
      });

      if (dto.serviceIds) {
        await tx.barberStaffService.deleteMany({ where: { staffId: id } });
        await tx.barberStaffService.createMany({
          data: dto.serviceIds.map((serviceId) => ({ staffId: id, serviceId })),
          skipDuplicates: true,
        });
      }

      return staff;
    });
  }

  async deleteStaff(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    await this.prisma.barberStaff.update({
      where: { id },
      data: { isActive: false },
    });
    return { ok: true };
  }

  private async assertServicesBelongToBranch(
    ctx: TenantContext,
    serviceIds: string[],
  ) {
    if (serviceIds.length === 0) return;
    const services = await this.prisma.barberService.findMany({
      where: {
        id: { in: serviceIds },
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      select: { id: true },
    });
    if (services.length !== serviceIds.length) {
      throw new BadRequestException(
        'Some serviceIds do not belong to this branch',
      );
    }
  }
}
