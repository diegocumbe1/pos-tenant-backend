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
import { wholesaleTiersOf } from '../../shared/retail-pricing';
import {
  ProductVariantRow,
  resolveStockOptionId,
  syncProductVariants,
  variantStockSummary,
} from '../../shared/retail-product-variants';
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
      include: {
        category: { select: { id: true, name: true, emoji: true } },
        variants: { orderBy: { createdAt: 'asc' } },
      },
    });
    const visible = filters.lowStock
      ? products.filter((p) => p.trackStock && p.stock <= p.minStock)
      : products;

    const committed = await this.committedByProduct(
      ctx,
      visible.map((product) => product.id),
    );
    return visible.map((product) =>
      this.toProductDto(product, committed.get(product.id) ?? 0),
    );
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
      include: {
        category: { select: { id: true, name: true, emoji: true } },
        variants: { orderBy: { createdAt: 'asc' } },
      },
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
    const stockOptionId = resolveStockOptionId(dto.stockOptionId, options);

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
            wholesalePrice6COP: dto.wholesalePrice6COP,
            wholesalePrice12COP: dto.wholesalePrice12COP,
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
            stockOptionId,
          },
          include: {
            category: { select: { id: true, name: true, emoji: true } },
            variants: { orderBy: { createdAt: 'asc' } },
          },
        });

        // Materializa una fila por valor del grupo que reparte. Arrancan en 0:
        // el stock inicial queda entero como pendiente de repartir, porque
        // nadie dijo todavía cuántas son de cada aroma.
        await syncProductVariants(tx, {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: created.id,
          stockOptionId,
          options,
        });

        // El stock inicial entra al kardex: el inventario nunca cambia sin
        // rastro. Y establece el promedio: es la primera —y por ahora única—
        // entrada, así que el promedio ES el costo con el que se cargó.
        if (initialStock > 0) {
          await tx.retailProduct.update({
            where: { id: created.id },
            data: { avgCostCOP: created.costCOP },
          });
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

        // Se relee porque `created` se resolvió antes de materializar las
        // variantes: ese objeto las traería vacías.
        return tx.retailProduct.findUniqueOrThrow({
          where: { id: created.id },
          include: {
            category: { select: { id: true, name: true, emoji: true } },
            variants: { orderBy: { createdAt: 'asc' } },
          },
        });
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
    const current = await this.prisma.retailProduct.findUniqueOrThrow({
      where: { id },
      select: { imageUrls: true, options: true, stockOptionId: true },
    });

    // Las opciones se revalidan contra las fotos que quedarán guardadas, no
    // contra las que llegan: si el admin borró una foto que un color usaba, la
    // referencia debe morir con ella aunque el cliente no reenvíe las opciones.
    const effectiveOptions = sanitizeProductOptions(
      dto.options ?? readProductOptions(current.options),
      dto.imageUrls ?? current.imageUrls,
    );
    let options: Prisma.InputJsonValue | typeof Prisma.DbNull | undefined;
    if (dto.options !== undefined || dto.imageUrls !== undefined) {
      options =
        (effectiveOptions as Prisma.InputJsonValue | null) ?? Prisma.DbNull;
    }

    // El grupo que reparte se valida contra las opciones que van a quedar
    // guardadas: si el admin borró el grupo de aromas en este mismo guardado,
    // el producto deja de repartir en vez de apuntar a un grupo fantasma.
    const stockOptionId = resolveStockOptionId(
      dto.stockOptionId === undefined
        ? current.stockOptionId
        : dto.stockOptionId,
      effectiveOptions,
    );

    // El stock no se edita aquí: se mueve por /retail/inventory para dejar kardex.
    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.retailProduct.update({
          where: { id },
          data: {
            categoryId: dto.categoryId,
            name: dto.name?.trim(),
            sku: dto.sku === undefined ? undefined : dto.sku.trim() || null,
            barcode:
              dto.barcode === undefined
                ? undefined
                : dto.barcode.trim() || null,
            brand:
              dto.brand === undefined ? undefined : dto.brand.trim() || null,
            description: dto.description,
            costCOP: dto.costCOP,
            priceCOP: dto.priceCOP,
            saleMarginPct: dto.saleMarginPct,
            minPriceCOP: dto.minPriceCOP,
            minMarginPct: dto.minMarginPct,
            // null apaga el escalón, undefined lo deja como estaba: Prisma ya
            // distingue los dos casos, así que se pasan tal cual.
            wholesalePrice6COP: dto.wholesalePrice6COP,
            wholesalePrice12COP: dto.wholesalePrice12COP,
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
            stockOptionId,
          },
        });

        // Crea las filas que falten, borra las de valores eliminados y refresca
        // las etiquetas. El conteo de las que sobreviven no se toca.
        await syncProductVariants(tx, {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: id,
          stockOptionId,
          options: effectiveOptions,
        });

        return tx.retailProduct.findUniqueOrThrow({
          where: { id },
          include: {
            category: { select: { id: true, name: true, emoji: true } },
            variants: { orderBy: { createdAt: 'asc' } },
          },
        });
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

  /**
   * Unidades ya vendidas que todavía no se han entregado, por producto.
   *
   * En una venta con entrega pendiente el stock NO se descuenta al cobrar: la
   * mercancía sigue en la estantería. Eso es correcto para el conteo físico,
   * pero sin este dato el mostrador ofrecería como libres unas unidades que ya
   * tienen dueño, y se venderían dos veces.
   *
   * No se resta del stock a propósito: `stock` tiene que seguir coincidiendo
   * con lo que hay al contar. Este número va al lado, como advertencia.
   */
  private async committedByProduct(
    ctx: TenantContext,
    productIds: string[],
  ): Promise<Map<string, number>> {
    if (productIds.length === 0) return new Map();

    const items = await this.prisma.retailSaleItem.findMany({
      where: {
        productId: { in: productIds },
        sale: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          status: 'COMPLETED',
          deliveryStatus: 'PENDING',
        },
      },
      select: { productId: true, quantity: true, deliveredQty: true },
    });

    const byProduct = new Map<string, number>();
    for (const item of items) {
      const pending = Math.max(0, item.quantity - item.deliveredQty);
      if (pending === 0) continue;
      byProduct.set(
        item.productId,
        (byProduct.get(item.productId) ?? 0) + pending,
      );
    }
    return byProduct;
  }

  private toProductDto(
    product: RetailProduct & {
      category?: { id: string; name: string; emoji: string | null } | null;
      variants?: ProductVariantRow[];
    },
    committedStock = 0,
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
      /**
       * Costo promedio de lo que hay. Es el que se usa al medir la utilidad;
       * `costCOP` es lo que cuesta reponer y es el que manda al poner precios.
       */
      avgCostCOP: product.avgCostCOP,
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
      // Precios por volumen: se devuelven crudos (para el formulario) y ya
      // resueltos en `wholesaleTiers` (para cualquiera que solo quiera leer la
      // rentabilidad sin repetir la fórmula). Los % no viven en la base.
      wholesalePrice6COP: product.wholesalePrice6COP,
      wholesalePrice12COP: product.wholesalePrice12COP,
      wholesaleTiers: wholesaleTiersOf(product),
      emoji: product.emoji,
      imageUrls: product.imageUrls,
      primaryImageUrl: product.imageUrls[0] ?? null,
      trackStock: product.trackStock,
      stock: product.stock,
      minStock: product.minStock,
      isLowStock: product.trackStock && product.stock <= product.minStock,
      // Vendido y sin entregar. NO se resta de `stock`: ese número tiene que
      // seguir coincidiendo con lo que hay al contar la estantería.
      committedStock,
      /** Lo que de verdad se puede vender hoy sin quedar mal con nadie. */
      availableStock: Math.max(0, product.stock - committedStock),
      // Reparto de existencias por opción. `stockOptionId` null y `variants`
      // vacío = el producto cuenta entero, que es el caso por defecto.
      stockOptionId: product.stockOptionId,
      variants: (product.variants ?? []).map((variant) => ({
        id: variant.id,
        optionValueId: variant.optionValueId,
        label: variant.label,
        sku: variant.sku,
        stock: variant.stock,
        minStock: variant.minStock,
        isLowStock: product.trackStock && variant.stock <= variant.minStock,
      })),
      ...variantStockSummary(product.stock, product.variants ?? []),
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
