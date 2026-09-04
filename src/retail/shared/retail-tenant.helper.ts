import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { TenantContext } from '../../auth/types/tenant-context.interface';

export type RetailScopedModel =
  | 'retailCategory'
  | 'retailProduct'
  | 'retailCustomer'
  | 'retailSale'
  | 'retailShipment'
  | 'retailSupplier';

/**
 * Guarda de aislamiento del vertical retail: ningún endpoint de /retail/* puede
 * operar sobre un tenant de otra vertical, y ningún registro puede leerse fuera
 * de su (tenantId, branchId).
 */
@Injectable()
export class RetailTenantHelper {
  constructor(private readonly prisma: PrismaService) {}

  async assertRetailTenant(tenantId: string): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: { select: { code: true } } },
    });
    if (tenant?.vertical?.code !== 'retail') {
      throw new BadRequestException('Tenant is not a retail vertical');
    }
  }

  async assertScopedRecord(
    model: RetailScopedModel,
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

  private findScopedRecord(model: RetailScopedModel, id: string) {
    const select = { tenantId: true, branchId: true } as const;
    switch (model) {
      case 'retailCategory':
        return this.prisma.retailCategory.findUnique({ where: { id }, select });
      case 'retailProduct':
        return this.prisma.retailProduct.findUnique({ where: { id }, select });
      case 'retailCustomer':
        return this.prisma.retailCustomer.findUnique({ where: { id }, select });
      case 'retailSale':
        return this.prisma.retailSale.findUnique({ where: { id }, select });
      case 'retailShipment':
        return this.prisma.retailShipment.findUnique({ where: { id }, select });
      case 'retailSupplier':
        return this.prisma.retailSupplier.findUnique({ where: { id }, select });
    }
  }
}
