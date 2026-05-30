import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberServiceDto,
  UpdateBarberServiceDto,
} from './dto/barber-service.dto';

@Injectable()
export class BarberServicesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async listServices(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberService.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createService(ctx: TenantContext, dto: CreateBarberServiceDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberService.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        description: dto.description,
        durationMin: dto.durationMin,
        priceCOP: dto.priceCOP,
        color: dto.color,
        sortOrder: dto.sortOrder,
      },
    });
  }

  async updateService(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberServiceDto,
  ) {
    await this.tenantHelper.assertScopedRecord('barberService', ctx, id, 'Service');
    return this.prisma.barberService.update({
      where: { id },
      data: dto,
    });
  }

  async deleteService(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord('barberService', ctx, id, 'Service');
    await this.prisma.barberService.update({
      where: { id },
      data: { isActive: false },
    });
    return { ok: true };
  }
}
