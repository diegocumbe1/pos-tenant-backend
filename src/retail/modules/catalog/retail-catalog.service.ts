import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RetailProduct } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  readProductOptions,
  sanitizeProductOptions,
} from '../../shared/retail-product-options';
import {
  CreateRetailCategoryDto,
  CreateRetailProductDto,
  UpdateRetailCategoryDto,
  UpdateRetailProductDto,
} from './dto/retail-catalog.dto';

@Injectable()
export class RetailCatalogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  // ─── Categorías ────────────────────────────────────────────────────────────

  async listCategories(ctx: TenantContext) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const categories = await this.prisma.retailCategory.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return categories.map((category) => ({
      id: category.id,
      name: category.name,
      emoji: category.emoji,
      sortOrder: category.sortOrder,
      isVisible: category.isVisible,
      createdAt: category.createdAt,
    }));
  }

  async createCategory(ctx: TenantContext, dto: CreateRetailCategoryDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    try {
      return await this.prisma.retailCategory.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name: dto.name.trim(),
          emoji: dto.emoji,
          sortOrder: dto.sortOrder ?? 0,
          isVisible: dto.isVisible ?? true,
        },
      });
    } catch (error) {
      throw this.mapUniqueError(error, `Ya existe una categoría "${dto.name}"`);
    }
  }

  async updateCategory(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailCategoryDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailCategory',
      ctx,
      id,
      'Category',
    );
    try {
      return await this.prisma.retailCategory.update({
        where: { id },
        data: {
          name: dto.name?.trim(),
          emoji: dto.emoji,
          sortOrder: dto.sortOrder,
          isVisible: dto.isVisible,
        },
      });
    } catch (error) {
      throw this.mapUniqueError(error, `Ya existe una categoría "${dto.name}"`);
    }
  }

  /** Soft-delete. Se bloquea si la categoría todavía tiene productos vivos. */
  async deleteCategory(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailCategory',
      ctx,
      id,
      'Category',
    );
    const remaining = await this.prisma.retailProduct.count({
      where: { categoryId: id, deletedAt: null },
    });
    if (remaining > 0) {
      throw new BadRequestException(
        `La categoría tiene ${remaining} producto(s). Muévelos o elimínalos primero.`,
      );
    }
    await this.prisma.retailCategory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  // ─── Productos ─────────────────────────────────────────────────────────────

  async listProducts(
    ctx: TenantContext,
    filters: { categoryId?: string; search?: string; lowStock?: boolean } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const products = await this.prisma.retailProduct.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        categoryId: filters.categoryId,
        ...(filters.search
          ? {
              OR: [
                { name: { contains: filters.search, mode: 'insensitive' } },
                { sku: { contains: filters.search, mode: 'insensitive' } },
                { barcode: { contains: filters.search, mode: 'insensitive' } },
                { brand: { contains: filters.search, mode: 'insensitive' } },
              ],
            }
          : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { category: { select: { id: true, name: true, emoji: true } } },
    });
    const visible = filters.lowStock
      ? products.filter((p) => p.trackStock && p.stock <= p.minStock)
      : products;
    return visible.map((product) => this.toProductDto(product));
  }

  /** Búsqueda por código de barras para el escáner del POS. */
  async findByBarcode(ctx: TenantContext, barcode: string) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const product = await this.prisma.retailProduct.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        barcode,
        deletedAt: null,
      },
      include: { category: { select: { id: true, name: true, emoji: true } } },
    });
    if (!product) {
      throw new NotFoundException(`Sin producto con código ${barcode}`);
    }
    return this.toProductDto(product);
  }

  async createProduct(ctx: TenantContext, dto: CreateRetailProductDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    await this.tenantHelper.assertScopedRecord(
      'retailCategory',
      ctx,
      dto.categoryId,
      'Category',
    );

    const initialStock = dto.trackStock === false ? 0 : (dto.stock ?? 0);
    const imageUrls = dto.imageUrls ?? [];
    const options = sanitizeProductOptions(dto.options, imageUrls);

    try {
      const product = await this.prisma.$transaction(async (tx) => {
        const created = await tx.retailProduct.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            categoryId: dto.categoryId,
            name: dto.name.trim(),
            sku: dto.sku?.trim() || null,
            barcode: dto.barcode?.trim() || null,
            brand: dto.brand?.trim() || null,
            description: dto.description,
            costCOP: dto.costCOP ?? 0,
            priceCOP: dto.priceCOP,
            saleMarginPct: dto.saleMarginPct,
            minPriceCOP: dto.minPriceCOP,
            minMarginPct: dto.minMarginPct,
            emoji: dto.emoji,
            imageUrls,
            trackStock: dto.trackStock ?? true,
            stock: initialStock,
            minStock: dto.minStock ?? 0,
            isActive: dto.isActive ?? true,
            isPublished: dto.isPublished ?? true,
            sortOrder: dto.sortOrder ?? 0,
            attributes: (dto.attributes ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            options: (options ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
          },
          include: {
            category: { select: { id: true, name: true, emoji: true } },
          },
        });

        // El stock inicial entra al kardex: el inventario nunca cambia sin rastro.
        if (initialStock > 0) {
          await tx.retailStockMovement.create({
            data: {
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              productId: created.id,
              type: 'INITIAL',
              quantity: initialStock,
              stockAfter: initialStock,
              unitCostCOP: created.costCOP,
              reason: 'Carga inicial',
              userId: ctx.userId,
            },
          });
        }

        return created;
      });
      return this.toProductDto(product);
    } catch (error) {
      throw this.mapUniqueError(error, `El SKU "${dto.sku}" ya existe`);
    }
  }

  async updateProduct(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailProductDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailProduct',
      ctx,
      id,
      'Product',
    );
    if (dto.categoryId) {
      await this.tenantHelper.assertScopedRecord(
        'retailCategory',
        ctx,
        dto.categoryId,
        'Category',
      );
    }
    // Las opciones se revalidan contra las fotos que quedarán guardadas, no
    // contra las que llegan: si el admin borró una foto que un color usaba, la
    // referencia debe morir con ella aunque el cliente no reenvíe las opciones.
    let options: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
    if (dto.options !== undefined || dto.imageUrls !== undefined) {
      const current = await this.prisma.retailProduct.findUnique({
        where: { id },
        select: { imageUrls: true, options: true },
      });
      const sanitized = sanitizeProductOptions(
        dto.options ?? readProductOptions(current?.options),
        dto.imageUrls ?? current?.imageUrls ?? [],
      );
      options = (sanitized as Prisma.InputJsonValue | null) ?? Prisma.DbNull;
    }

    // El stock no se edita aquí: se mueve por /retail/inventory para dejar kardex.
    try {
      const updated = await this.prisma.retailProduct.update({
        where: { id },
        data: {
          categoryId: dto.categoryId,
          name: dto.name?.trim(),
          sku: dto.sku === undefined ? undefined : dto.sku.trim() || null,
          barcode:
            dto.barcode === undefined ? undefined : dto.barcode.trim() || null,
          brand: dto.brand === undefined ? undefined : dto.brand.trim() || null,
          description: dto.description,
          costCOP: dto.costCOP,
          priceCOP: dto.priceCOP,
          saleMarginPct: dto.saleMarginPct,
          minPriceCOP: dto.minPriceCOP,
          minMarginPct: dto.minMarginPct,
          emoji: dto.emoji,
          imageUrls: dto.imageUrls,
          trackStock: dto.trackStock,
          minStock: dto.minStock,
          isActive: dto.isActive,
          isPublished: dto.isPublished,
          sortOrder: dto.sortOrder,
          attributes: (dto.attributes ?? undefined) as
            | Prisma.InputJsonValue
            | undefined,
          options,
        },
        include: {
          category: { select: { id: true, name: true, emoji: true } },
        },
      });
      return this.toProductDto(updated);
    } catch (error) {
      throw this.mapUniqueError(error, `El SKU "${dto.sku}" ya existe`);
    }
  }

  /** Soft-delete: el histórico de ventas debe seguir resolviendo el producto. */
  async deleteProduct(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailProduct',
      ctx,
      id,
      'Product',
    );
    await this.prisma.retailProduct.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false, isPublished: false },
    });
    return { ok: true };
  }

  private toProductDto(
    product: RetailProduct & {
      category?: { id: string; name: string; emoji: string | null } | null;
    },
  ) {
    const margin = product.priceCOP - product.costCOP;
    return {
      id: product.id,
      tenantId: product.tenantId,
      branchId: product.branchId,
      categoryId: product.categoryId,
      categoryName: product.category?.name ?? null,
      categoryEmoji: product.category?.emoji ?? null,
      name: product.name,
      sku: product.sku,
      barcode: product.barcode,
      brand: product.brand,
      description: product.description,
      costCOP: product.costCOP,
      priceCOP: product.priceCOP,
      marginCOP: margin,
      // Margen real derivado del precio guardado (no del % sugerido): si el
      // admin escribió un precio a mano, manda ese.
      marginPct:
        product.priceCOP > 0
          ? Math.round((margin / product.priceCOP) * 1000) / 10
          : 0,
      saleMarginPct: product.saleMarginPct,
      minPriceCOP: product.minPriceCOP,
      minMarginPct: product.minMarginPct,
      minMarginCOP:
        product.minPriceCOP !== null
          ? product.minPriceCOP - product.costCOP
          : null,
      emoji: product.emoji,
      imageUrls: product.imageUrls,
      primaryImageUrl: product.imageUrls[0] ?? null,
      trackStock: product.trackStock,
      stock: product.stock,
      minStock: product.minStock,
      isLowStock: product.trackStock && product.stock <= product.minStock,
      isActive: product.isActive,
      isPublished: product.isPublished,
      sortOrder: product.sortOrder,
      attributes: product.attributes,
      // Siempre array: el formulario del admin no tiene que distinguir entre
      // "nunca se configuró" y "se vació".
      options: readProductOptions(product.options),
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  private mapUniqueError(error: unknown, message: string): Error {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002'
    ) {
      return new ConflictException(message);
    }
    return error as Error;
  }
}
