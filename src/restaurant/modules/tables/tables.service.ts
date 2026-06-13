import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';

@Injectable()
export class TablesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(ctx: TenantContext) {
    const tables = await this.prisma.restaurantTable.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, deletedAt: null },
      include: {
        area: { select: { id: true, name: true, emoji: true } },
        orders: {
          where: { status: 'OPEN' },
          select: {
            createdAt: true,
            items: { select: { priceCOP: true, qty: true } },
          },
        },
      },
      orderBy: { code: 'asc' },
    });

    const now = Date.now();

    return {
      tables: tables.map(({ orders, ...t }) => {
        const openOrder = orders[0] ?? null;
        const totalCOP = openOrder
          ? openOrder.items.reduce((sum, i) => sum + i.priceCOP * i.qty, 0)
          : null;
        const minutesOpen = openOrder
          ? Math.floor((now - openOrder.createdAt.getTime()) / 60000)
          : null;

        return { ...t, totalCOP, minutesOpen };
      }),
    };
  }

  /** Mesas en la papelera (soft-deleted). */
  async findTrash(ctx: TenantContext) {
    const tables = await this.prisma.restaurantTable.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId, deletedAt: { not: null } },
      include: { area: { select: { id: true, name: true, emoji: true } } },
      orderBy: { deletedAt: 'desc' },
    });
    return { tables };
  }

  async create(ctx: TenantContext, dto: CreateTableDto) {
    const existing = await this.prisma.restaurantTable.findFirst({
      where: { branchId: ctx.branchId, code: dto.code },
      select: { deletedAt: true },
    });
    if (existing) {
      throw new ConflictException(
        existing.deletedAt
          ? `La mesa ${dto.code} está en la papelera. Restáurala o elimínala definitivamente.`
          : `Table code ${dto.code} already exists`,
      );
    }

    return this.prisma.restaurantTable.create({
      data: { ...dto, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateTableDto) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    return this.prisma.restaurantTable.update({ where: { id }, data: dto });
  }

  /** Soft-delete: mueve la mesa a la papelera. */
  async remove(ctx: TenantContext, id: string) {
    await this.assertBelongsToTenant(id, ctx.tenantId);

    const openOrders = await this.prisma.order.count({
      where: { tableId: id, status: 'OPEN' },
    });
    if (openOrders > 0) {
      throw new ConflictException(
        'No se puede eliminar una mesa con una orden abierta.',
      );
    }

    await this.prisma.restaurantTable.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  async restore(ctx: TenantContext, id: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { tenantId: true },
    });
    if (!table) throw new NotFoundException(`Table ${id} not found in trash`);
    if (table.tenantId !== ctx.tenantId)
      throw new ForbiddenException('Table does not belong to your tenant');

    await this.prisma.restaurantTable.update({
      where: { id },
      data: { deletedAt: null },
    });
    return { id, restored: true };
  }

  /** Eliminación definitiva (hard delete). */
  async purge(ctx: TenantContext, id: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id, deletedAt: { not: null } },
      select: { tenantId: true },
    });
    if (!table) throw new NotFoundException(`Table ${id} not found in trash`);
    if (table.tenantId !== ctx.tenantId)
      throw new ForbiddenException('Table does not belong to your tenant');

    await this.prisma.$transaction([
      this.prisma.reservation.deleteMany({ where: { tableId: id } }),
      this.prisma.restaurantTable.delete({ where: { id } }),
    ]);
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id, deletedAt: null },
      select: { tenantId: true },
    });
    if (!table) throw new NotFoundException(`Table ${id} not found`);
    if (table.tenantId !== tenantId)
      throw new ForbiddenException('Table does not belong to your tenant');
  }
}
