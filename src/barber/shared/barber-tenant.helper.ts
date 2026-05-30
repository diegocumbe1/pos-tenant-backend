import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../auth/types/tenant-context.interface';

export type BarberScopedModel =
  | 'barberAppointment'
  | 'barberCustomer'
  | 'barberService'
  | 'barberStaff';

@Injectable()
export class BarberTenantHelper {
  constructor(private readonly prisma: PrismaService) {}

  async assertBarberTenant(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: { select: { code: true } } },
    });
    if (tenant?.vertical?.code !== 'barber') {
      throw new BadRequestException('Tenant is not a barber vertical');
    }
  }

  async assertScopedRecord(
    model: BarberScopedModel,
    ctx: TenantContext,
    id: string,
    label: string,
  ): Promise<void> {
    const record = await this.findScopedRecord(model, id);
    if (
      !record ||
      record.tenantId !== ctx.tenantId ||
      record.branchId !== ctx.branchId
    ) {
      throw new NotFoundException(`${label} ${id} not found`);
    }
  }

  private findScopedRecord(model: BarberScopedModel, id: string) {
    const select = { tenantId: true, branchId: true } as const;
    switch (model) {
      case 'barberAppointment':
        return this.prisma.barberAppointment.findUnique({ where: { id }, select });
      case 'barberCustomer':
        return this.prisma.barberCustomer.findUnique({ where: { id }, select });
      case 'barberService':
        return this.prisma.barberService.findUnique({ where: { id }, select });
      case 'barberStaff':
        return this.prisma.barberStaff.findUnique({ where: { id }, select });
    }
  }
}
