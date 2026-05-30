import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberCustomerDto,
  UpdateBarberCustomerDto,
} from './dto/barber-customer.dto';

@Injectable()
export class BarberCustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async listCustomers(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberCustomer.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: [{ name: 'asc' }],
    });
  }

  async createCustomer(ctx: TenantContext, dto: CreateBarberCustomerDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberCustomer.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        notes: dto.notes,
        tags: dto.tags ?? [],
      },
    });
  }

  async updateCustomer(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberCustomerDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberCustomer',
      ctx,
      id,
      'Customer',
    );
    return this.prisma.barberCustomer.update({
      where: { id },
      data: dto,
    });
  }
}
