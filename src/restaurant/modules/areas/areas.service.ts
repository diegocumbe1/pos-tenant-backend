import {
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
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { _count: { select: { tables: true } } },
      orderBy: { name: 'asc' },
    });

    return {
      areas: areas.map(({ _count, ...a }) => ({
        ...a,
        tableCount: _count.tables,
      })),
    };
  }

  async create(ctx: TenantContext, dto: CreateAreaDto) {
    return this.prisma.area.create({
      data: { ...dto, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateAreaDto) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    return this.prisma.area.update({ where: { id }, data: dto });
  }

  async remove(ctx: TenantContext, id: string) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    await this.prisma.area.delete({ where: { id } });
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const area = await this.prisma.area.findFirst({
      where: { id },
      select: { tenantId: true },
    });
    if (!area) throw new NotFoundException(`Area ${id} not found`);
    if (area.tenantId !== tenantId)
      throw new ForbiddenException('Area does not belong to your tenant');
  }
}
