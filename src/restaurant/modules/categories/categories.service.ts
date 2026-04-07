import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';

@Injectable()
export class CategoriesService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(ctx: TenantContext) {
    const categories = await this.prisma.productCategory.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { sortOrder: 'asc' },
    });
    return { categories };
  }

  async create(ctx: TenantContext, dto: CreateCategoryDto) {
    return this.prisma.productCategory.create({
      data: {
        ...dto,
        tenantId: ctx.tenantId,
      },
    });
  }

  async update(ctx: TenantContext, id: string, dto: UpdateCategoryDto) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    return this.prisma.productCategory.update({
      where: { id },
      data: dto,
    });
  }

  async remove(ctx: TenantContext, id: string) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    await this.prisma.productCategory.delete({ where: { id } });
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const category = await this.prisma.productCategory.findFirst({
      where: { id },
      select: { tenantId: true },
    });

    if (!category) {
      throw new NotFoundException(`Category ${id} not found`);
    }

    if (category.tenantId !== tenantId) {
      throw new ForbiddenException('Category does not belong to your tenant');
    }
  }
}
