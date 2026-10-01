import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberServiceCategoryDto,
  UpdateBarberServiceCategoryDto,
} from './dto/barber-service-category.dto';

/**
 * Lista gestionada de categorías. El servicio guarda el NOMBRE (no un id): el
 * sitio público y los reportes agrupan por ese texto, así que renombrar o
 * borrar una categoría reescribe los servicios que la usan, en la misma
 * transacción.
 */
@Injectable()
export class BarberServiceCategoriesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async list(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const [categories, usage] = await Promise.all([
      this.prisma.barberServiceCategory.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.barberService.groupBy({
        by: ['category'],
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
        _count: { _all: true },
      }),
    ]);
    const counts = new Map(usage.map((u) => [u.category, u._count._all]));
    return categories.map((c) => ({
      id: c.id,
      name: c.name,
      sortOrder: c.sortOrder,
      serviceCount: counts.get(c.name) ?? 0,
    }));
  }

  async create(ctx: TenantContext, dto: CreateBarberServiceCategoryDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const name = dto.name.trim();
    const sortOrder =
      dto.sortOrder ??
      (await this.prisma.barberServiceCategory.count({
        where: { branchId: ctx.branchId },
      }));
    try {
      const created = await this.prisma.barberServiceCategory.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name,
          sortOrder,
        },
      });
      return { ...created, serviceCount: 0 };
    } catch (error) {
      throw this.mapUniqueError(error, name);
    }
  }

  async update(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberServiceCategoryDto,
  ) {
    const current = await this.findScoped(ctx, id);
    const name = dto.name?.trim();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.barberServiceCategory.update({
          where: { id },
          data: { name, sortOrder: dto.sortOrder },
        });
        let serviceCount = 0;
        if (name && name !== current.name) {
          const res = await tx.barberService.updateMany({
            where: { branchId: ctx.branchId, category: current.name },
            data: { category: name },
          });
          serviceCount = res.count;
        } else {
          serviceCount = await tx.barberService.count({
            where: { branchId: ctx.branchId, category: updated.name },
          });
        }
        return { ...updated, serviceCount };
      });
    } catch (error) {
      throw this.mapUniqueError(error, name ?? current.name);
    }
  }

  // Los servicios que la usaban quedan sin categoría ("Otros" en el sitio).
  async remove(ctx: TenantContext, id: string) {
    const current = await this.findScoped(ctx, id);
    const res = await this.prisma.$transaction(async (tx) => {
      const cleared = await tx.barberService.updateMany({
        where: { branchId: ctx.branchId, category: current.name },
        data: { category: null },
      });
      await tx.barberServiceCategory.delete({ where: { id } });
      return cleared;
    });
    return { ok: true, servicesCleared: res.count };
  }

  private async findScoped(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const found = await this.prisma.barberServiceCategory.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!found) throw new NotFoundException(`Category ${id} not found`);
    return found;
  }

  private mapUniqueError(error: unknown, name: string) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(`Ya existe la categoría "${name}"`);
    }
    return error;
  }
}
