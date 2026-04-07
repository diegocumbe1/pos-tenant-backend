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
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
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

  async create(ctx: TenantContext, dto: CreateTableDto) {
    const existing = await this.prisma.restaurantTable.findFirst({
      where: { branchId: ctx.branchId, code: dto.code },
    });
    if (existing) throw new ConflictException(`Table code ${dto.code} already exists`);

    return this.prisma.restaurantTable.create({
      data: { ...dto, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateTableDto) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    return this.prisma.restaurantTable.update({ where: { id }, data: dto });
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const table = await this.prisma.restaurantTable.findFirst({
      where: { id },
      select: { tenantId: true },
    });
    if (!table) throw new NotFoundException(`Table ${id} not found`);
    if (table.tenantId !== tenantId)
      throw new ForbiddenException('Table does not belong to your tenant');
  }
}
