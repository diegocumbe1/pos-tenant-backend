import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateAreaDto } from './dto/create-area.dto';
import { UpdateAreaDto } from './dto/update-area.dto';

@Injectable()
export class AreasService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(ctx: TenantContext) {
    const areas = await this.prisma.area.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, deletedAt: null },
      include: { _count: { select: { tables: { where: { deletedAt: null } } } } },
      orderBy: { name: 'asc' },
    });

    return {
      areas: areas.map(({ _count, ...a }) => ({
        ...a,
        tableCount: _count.tables,
      })),
    };
  }

  /** Áreas en la papelera (soft-deleted). */
  async findTrash(ctx: TenantContext) {
    const areas = await this.prisma.area.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, deletedAt: { not: null } },
      include: { _count: { select: { tables: { where: { deletedAt: { not: null } } } } } },
      orderBy: { deletedAt: 'desc' },
    });

    return {
      areas: areas.map(({ _count, ...a }) => ({
        ...a,
        tableCount: _count.tables,
      })),
    };
  }

  async create(ctx: TenantContext, dto: CreateAreaDto) {
    const existing = await this.prisma.area.findFirst({
      where: { branchId: ctx.branchId, name: dto.name },
      select: { deletedAt: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.deletedAt
          ? `Ya existe un área "${dto.name}" en la papelera. Restáurala o elimínala definitivamente.`
          : `Ya existe un área "${dto.name}"`,
      );
    }

    return this.prisma.area.create({
      data: { ...dto, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateAreaDto) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    return this.prisma.area.update({ where: { id }, data: dto });
  }

  /** Soft-delete: mueve el área y sus mesas a la papelera. */
  async remove(ctx: TenantContext, id: string) {
    await this.assertBelongsToTenant(id, ctx.tenantId);

    const tableIds = (
      await this.prisma.restaurantTable.findMany({
        where: { areaId: id, deletedAt: null },
        select: { id: true },
      })
    ).map((t) => t.id);

    if (tableIds.length) {
      const openOrders = await this.prisma.order.count({
        where: { tableId: { in: tableIds }, status: 'OPEN' },
      });
      if (openOrders > 0) {
        throw new ConflictException(
          'El área tiene mesas con órdenes abiertas; ciérralas antes de eliminar.',
        );
      }
    }

    // Mismo timestamp en área + mesas → permite restaurarlas juntas.
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.restaurantTable.updateMany({
        where: { areaId: id, deletedAt: null },
        data: { deletedAt: now },
      }),
      this.prisma.area.update({ where: { id }, data: { deletedAt: now } }),
    ]);
  }

  /** Restaura el área y las mesas eliminadas junto con ella. */
  async restore(ctx: TenantContext, id: string) {
    const area = await this.prisma.area.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { tenantId: true, deletedAt: true },
    });
    if (!area) throw new NotFoundException(`Area ${id} not found in trash`);
    if (area.tenantId !== ctx.tenantId)
      throw new ForbiddenException('Area does not belong to your tenant');

    await this.prisma.$transaction([
      this.prisma.restaurantTable.updateMany({
        where: { areaId: id, deletedAt: area.deletedAt },
        data: { deletedAt: null },
      }),
      this.prisma.area.update({ where: { id }, data: { deletedAt: null } }),
    ]);
    return { id, restored: true };
  }

  /** Eliminación definitiva (hard delete) del área y sus mesas en papelera. */
  async purge(ctx: TenantContext, id: string) {
    const area = await this.prisma.area.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { tenantId: true },
    });
    if (!area) throw new NotFoundException(`Area ${id} not found in trash`);
    if (area.tenantId !== ctx.tenantId)
      throw new ForbiddenException('Area does not belong to your tenant');

    const trashedTables = (
      await this.prisma.restaurantTable.findMany({
        where: { areaId: id, deletedAt: { not: null } },
        select: { id: true },
      })
    ).map((t) => t.id);

    await this.prisma.$transaction([
      this.prisma.reservation.deleteMany({ where: { tableId: { in: trashedTables } } }),
      this.prisma.restaurantTable.deleteMany({ where: { id: { in: trashedTables } } }),
      this.prisma.area.delete({ where: { id } }),
    ]);
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const area = await this.prisma.area.findFirst({
      where: { id, deletedAt: null },
      select: { tenantId: true },
    });
    if (!area) throw new NotFoundException(`Area ${id} not found`);
    if (area.tenantId !== tenantId)
      throw new ForbiddenException('Area does not belong to your tenant');
  }
}
