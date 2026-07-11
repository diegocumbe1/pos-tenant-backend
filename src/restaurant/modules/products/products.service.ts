import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';

@Injectable()
export class ProductsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAll(ctx: TenantContext) {
    const [products, categories] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          tenantId: ctx.tenantId,
          deletedAt: null,
          ...(ctx.branchId
            ? { OR: [{ branchId: null }, { branchId: ctx.branchId }] }
            : { branchId: null }),
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.productCategory.findMany({
        where: {
          tenantId: ctx.tenantId,
          ...(ctx.branchId
            ? { OR: [{ branchId: null }, { branchId: ctx.branchId }] }
            : { branchId: null }),
        },
        orderBy: { sortOrder: 'asc' },
      }),
    ]);

    return { products, categories };
  }

  async create(ctx: TenantContext, dto: CreateProductDto) {
    await this.assertCategoryAvailableForBranch(
      dto.categoryId,
      ctx.tenantId,
      ctx.branchId,
    );

    const product = await this.prisma.product.create({
      data: {
        ...dto,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId || null,
        imageUrls: dto.imageUrls ?? [],
      },
    });

    // Precio inicial → primera entrada del histórico (best-effort: nunca bloquea el create).
    await this.recordPriceHistory(ctx, product.id, product.priceCOP, product.targetMarginPct);

    return product;
  }

  async update(ctx: TenantContext, id: string, dto: UpdateProductDto) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    if (dto.categoryId) {
      await this.assertCategoryAvailableForBranch(
        dto.categoryId,
        ctx.tenantId,
        ctx.branchId,
      );
    }

    // Si cambia precio o % objetivo, registra una entrada en el histórico (trazabilidad).
    const touchesPricing =
      dto.priceCOP !== undefined || dto.targetMarginPct !== undefined;

    const updated = await this.prisma.product.update({
      where: { id },
      data: dto,
    });

    if (touchesPricing) {
      await this.recordPriceHistory(ctx, id, updated.priceCOP, updated.targetMarginPct);
    }

    return updated;
  }

  /**
   * Registra una entrada del histórico de precio. Best-effort: si la tabla aún no
   * existe (migración sin aplicar) o falla, NO bloquea el create/update del producto.
   */
  private async recordPriceHistory(
    ctx: TenantContext,
    productId: string,
    priceCOP: number,
    targetMarginPct: number,
  ) {
    try {
      await this.prisma.productPriceHistory.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId || null,
          productId,
          priceCOP,
          targetMarginPct,
          changedByUserId: ctx.userId ?? null,
        },
      });
    } catch {
      // Trazabilidad no crítica: se ignora si la migración aún no está aplicada.
    }
  }

  async priceHistory(ctx: TenantContext, id: string) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    const history = await this.prisma.productPriceHistory.findMany({
      where: { tenantId: ctx.tenantId, productId: id },
      orderBy: { createdAt: 'desc' },
    });
    return { history };
  }

  async toggle(ctx: TenantContext, id: string) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    const product = await this.prisma.product.findUniqueOrThrow({
      where: { id },
      select: { isAvailable: true },
    });
    return this.prisma.product.update({
      where: { id },
      data: { isAvailable: !product.isAvailable },
    });
  }

  async remove(ctx: TenantContext, id: string) {
    await this.assertBelongsToTenant(id, ctx.tenantId);
    await this.prisma.product.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
  }

  private async assertBelongsToTenant(id: string, tenantId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: { tenantId: true },
    });

    if (!product) {
      throw new NotFoundException(`Product ${id} not found`);
    }

    if (product.tenantId !== tenantId) {
      throw new ForbiddenException('Product does not belong to your tenant');
    }
  }

  private async assertCategoryAvailableForBranch(
    categoryId: string,
    tenantId: string,
    branchId: string,
  ) {
    const category = await this.prisma.productCategory.findFirst({
      where: { id: categoryId },
      select: { tenantId: true, branchId: true },
    });

    if (!category) {
      throw new BadRequestException(`Category ${categoryId} not found`);
    }

    if (category.tenantId !== tenantId) {
      throw new ForbiddenException('Category does not belong to your tenant');
    }

    if (category.branchId && category.branchId !== branchId) {
      throw new ForbiddenException('Category does not belong to this branch');
    }
  }
}
