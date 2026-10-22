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
import { allocateIn } from '../../shared/retail-stock-locations';
import { lotDay } from '../../shared/retail-stock-lots';
import {
  readProductOptions,
  sanitizeProductOptions,
} from '../../shared/retail-product-options';
import {
  costFromListPrice,
  effectiveListDiscountPct,
  wholesaleTiersOf,
} from '../../shared/retail-pricing';
import {
  ProductVariantRow,
  resolveStockOptionIds,
  syncProductVariants,
  variantStockSummary,
} from '../../shared/retail-product-variants';
import {
  CreateRetailCategoryDto,
  CreateRetailProductDto,
  RecalculateListCostsDto,
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
      ? products.filter(
          (p) => p.isActive && p.trackStock && p.stock <= p.minStock,
        )
      : products;

    const [committed, expiry] = await Promise.all([
      this.committedByProduct(
        ctx,
        visible.map((product) => product.id),
      ),
      this.nextExpiryByKey(
        ctx,
        visible.filter((product) => product.tracksExpiry).map((p) => p.id),
      ),
    ]);
    return visible.map((product) =>
      // `false` = sin filas de reparto. El resumen (`variantCount`, `assignedStock`,
      // `hasLowStockVariant`) sí viaja, que es lo único que un listado necesita.
      this.toProductDto(product, committed.get(product.id) ?? 0, false, expiry),
    );
  }

  /**
   * Un producto con TODO su detalle, incluidas las filas de variante.
   *
   * Existe para que el listado no tenga que traerlas: quien abre el selector del mostrador, el
   * panel de reparto o el formulario de movimiento necesita las filas de UN producto, no las de
   * todo el catálogo. Ver docs/PLAN_VARIANTES_MULTIDIMENSION_RETAIL.md §4.
   *
   * `committedStock` se calcula igual que en el listado: sin él, `availableStock` vendría inflado y
   * el mostrador dejaría vender mercancía que ya tiene dueño.
   */
  async getProduct(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const product = await this.prisma.retailProduct.findFirst({
      // tenantId + branchId en el WHERE, no solo el id: un id de otra tienda tiene que devolver
      // 404, nunca el producto.
      where: {
        id,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      include: {
        category: { select: { id: true, name: true, emoji: true } },
        variants: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');

    const [committed, expiry] = await Promise.all([
      this.committedByProduct(ctx, [product.id]),
      this.nextExpiryByKey(ctx, product.tracksExpiry ? [product.id] : []),
    ]);
    return this.toProductDto(
      product,
      committed.get(product.id) ?? 0,
      true,
      expiry,
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
    // `stockOptionIds` manda; `stockOptionId` se acepta por compatibilidad mientras los clientes
    // viejos sigan mandándolo. Ver docs/PLAN_VARIANTES_MULTIDIMENSION_RETAIL.md.
    const stockOptionIds = resolveStockOptionIds(
      dto.stockOptionIds ?? (dto.stockOptionId ? [dto.stockOptionId] : []),
      options,
    );

    const pricingMode = dto.pricingMode ?? 'COST_MARGIN';
    const supplierId = dto.supplierId || null;
    const supplierPct = await this.supplierListPct(ctx, supplierId);
    const listPricing =
      pricingMode === 'LIST_DISCOUNT'
        ? this.listPricing(dto.priceCOP, dto.listDiscountPct, supplierPct)
        : null;

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
            // En LIST_DISCOUNT el costo no se escribe: sale del precio.
            costCOP: listPricing?.costCOP ?? dto.costCOP ?? 0,
            priceCOP: dto.priceCOP,
            saleMarginPct: listPricing?.saleMarginPct ?? dto.saleMarginPct,
            pricingMode,
            supplierId,
            listDiscountPct: dto.listDiscountPct ?? null,
            minPriceCOP: dto.minPriceCOP,
            minMarginPct: dto.minMarginPct,
            wholesalePrice6COP: dto.wholesalePrice6COP,
            wholesalePrice12COP: dto.wholesalePrice12COP,
            emoji: dto.emoji,
            imageUrls,
            trackStock: dto.trackStock ?? true,
            tracksExpiry: dto.tracksExpiry ?? false,
            expiryAlertDays: dto.expiryAlertDays ?? null,
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
            stockOptionIds,
            // Se sigue llenando mientras la columna vieja exista: un rollback del despliegue tiene
            // que encontrar el producto utilizable. Solo tiene sentido con UNA dimensión.
            stockOptionId:
              stockOptionIds.length === 1 ? stockOptionIds[0] : null,
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
          stockOptionIds,
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
          // TODO NACE EN PRINCIPAL. Un producto nuevo entra a la casa; de ahí se
          // reparte después con un traslado, que es lo que de verdad pasó.
          const locationId = await allocateIn(tx, ctx, {
            productId: created.id,
            quantity: initialStock,
            lots:
              created.tracksExpiry && dto.initialExpiresOn
                ? { kind: 'dated', expiresOn: dto.initialExpiresOn }
                : undefined,
          });
          await tx.retailStockMovement.create({
            data: {
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              productId: created.id,
              type: 'INITIAL',
              quantity: initialStock,
              stockAfter: initialStock,
              locationId,
              unitCostCOP: created.costCOP,
              reason: 'Carga inicial',
              userId: ctx.userId,
            },
          });
        }

        // El primer punto del histórico de precios. Sin esto, el producto
        // arrancaría diciendo que su precio nunca se puso.
        await tx.retailProductPriceHistory.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId: created.id,
            priceCOP: created.priceCOP,
            costCOP: created.costCOP,
            reason: listPricing
              ? `Precio al crear el producto (lista −${listPricing.pct}%)`
              : 'Precio al crear el producto',
            userId: ctx.userId,
          },
        });

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
      select: {
        imageUrls: true,
        options: true,
        stockOptionId: true,
        stockOptionIds: true,
        priceCOP: true,
        costCOP: true,
        pricingMode: true,
        supplierId: true,
        listDiscountPct: true,
      },
    });

    // El costo se recalcula desde el precio de lista solo cuando el guardado
    // toca algo que lo determina. Así, si el % del proveedor cambió, un
    // producto no se reescribe por editarle el nombre desde otra pantalla; el
    // formulario de precios sí manda el precio y muestra el costo antes de
    // guardar, así que ahí no hay sorpresa.
    const nextMode = dto.pricingMode ?? current.pricingMode;
    const nextSupplierId =
      dto.supplierId !== undefined
        ? dto.supplierId || null
        : current.supplierId;
    const nextListPct =
      dto.listDiscountPct !== undefined
        ? dto.listDiscountPct
        : current.listDiscountPct;
    // Por VALOR, no por presencia: el formulario manda el precio siempre, y
    // comparar por presencia recalcularía el costo al cambiarle el nombre.
    const touchesListPricing =
      nextMode !== current.pricingMode ||
      nextSupplierId !== current.supplierId ||
      nextListPct !== current.listDiscountPct ||
      (dto.priceCOP !== undefined && dto.priceCOP !== current.priceCOP);
    const supplierPct =
      dto.supplierId !== undefined ||
      (nextMode === 'LIST_DISCOUNT' && touchesListPricing)
        ? await this.supplierListPct(ctx, nextSupplierId)
        : null;
    const listPricing =
      nextMode === 'LIST_DISCOUNT' && touchesListPricing
        ? this.listPricing(
            dto.priceCOP ?? current.priceCOP,
            nextListPct,
            supplierPct,
          )
        : null;

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
    const stockOptionIds = resolveStockOptionIds(
      dto.stockOptionIds !== undefined
        ? (dto.stockOptionIds ?? [])
        : dto.stockOptionId !== undefined
          ? dto.stockOptionId
            ? [dto.stockOptionId]
            : []
          : // Sin nada en el dto se conserva lo guardado. `stockOptionIds` puede venir vacío en
            // filas anteriores a la migración, y ahí manda el campo viejo.
            current.stockOptionIds.length > 0
            ? current.stockOptionIds
            : current.stockOptionId
              ? [current.stockOptionId]
              : [],
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
            costCOP: listPricing?.costCOP ?? dto.costCOP,
            priceCOP: dto.priceCOP,
            saleMarginPct: listPricing?.saleMarginPct ?? dto.saleMarginPct,
            pricingMode: dto.pricingMode,
            supplierId:
              dto.supplierId === undefined ? undefined : dto.supplierId || null,
            listDiscountPct: dto.listDiscountPct,
            minPriceCOP: dto.minPriceCOP,
            minMarginPct: dto.minMarginPct,
            // null apaga el escalón, undefined lo deja como estaba: Prisma ya
            // distingue los dos casos, así que se pasan tal cual.
            wholesalePrice6COP: dto.wholesalePrice6COP,
            wholesalePrice12COP: dto.wholesalePrice12COP,
            emoji: dto.emoji,
            imageUrls: dto.imageUrls,
            trackStock: dto.trackStock,
            tracksExpiry: dto.tracksExpiry,
            expiryAlertDays: dto.expiryAlertDays,
            minStock: dto.minStock,
            isActive: dto.isActive,
            isPublished: dto.isPublished,
            sortOrder: dto.sortOrder,
            attributes: (dto.attributes ?? undefined) as
              | Prisma.InputJsonValue
              | undefined,
            options,
            stockOptionIds,
            stockOptionId:
              stockOptionIds.length === 1 ? stockOptionIds[0] : null,
          },
        });

        // Un cambio de precio o de costo deja huella. Solo cuando de verdad
        // cambia: guardar una fila cada vez que se guarda el producto llenaría
        // el histórico de renglones idénticos y escondería los saltos reales,
        // que son los que explican por qué una venta dejó menos margen.
        const nextPrice = dto.priceCOP ?? current.priceCOP;
        const nextCost = listPricing?.costCOP ?? dto.costCOP ?? current.costCOP;
        if (nextPrice !== current.priceCOP || nextCost !== current.costCOP) {
          await tx.retailProductPriceHistory.create({
            data: {
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              productId: id,
              priceCOP: nextPrice,
              prevPriceCOP: current.priceCOP,
              costCOP: nextCost,
              prevCostCOP: current.costCOP,
              reason: listPricing
                ? `Desde precio de lista −${listPricing.pct}%`
                : undefined,
              userId: ctx.userId,
            },
          });
        }

        // Crea las filas que falten, borra las de valores eliminados y refresca
        // las etiquetas. El conteo de las que sobreviven no se toca.
        await syncProductVariants(tx, {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: id,
          stockOptionIds,
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

  // ─── Precio de lista: recalcular por proveedor ──────────────────────────────

  /**
   * Qué productos cambiarían de costo si se aplica el % ACTUAL del proveedor.
   *
   * Existe porque cambiar el % de un proveedor no reescribe nada solo: el costo
   * guardado es un hecho (con él se midió el margen de las ventas de hasta hoy)
   * y moverlo en silencio escondería el salto. El admin ve la lista y decide.
   * Solo entran los que toman el % del proveedor: un producto con % propio ya
   * dijo que no sigue al proveedor.
   */
  async previewListCosts(ctx: TenantContext, supplierId: string) {
    const supplier = await this.listSupplier(ctx, supplierId);
    const products = await this.prisma.retailProduct.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        supplierId,
        pricingMode: 'LIST_DISCOUNT',
        listDiscountPct: null,
        deletedAt: null,
      },
      select: { id: true, name: true, priceCOP: true, costCOP: true },
      orderBy: { name: 'asc' },
    });
    const pct = supplier.listDiscountPct;
    const changes =
      pct === null
        ? []
        : products
            .map((product) => ({
              id: product.id,
              name: product.name,
              priceCOP: product.priceCOP,
              costCOP: product.costCOP,
              nextCostCOP: costFromListPrice(product.priceCOP, pct),
            }))
            .filter((row) => row.nextCostCOP !== row.costCOP);
    return {
      supplierId: supplier.id,
      supplierName: supplier.name,
      listDiscountPct: pct,
      productCount: products.length,
      changes,
    };
  }

  /** Aplica la vista previa. Cada costo que cambia deja su fila de histórico. */
  async recalculateListCosts(ctx: TenantContext, dto: RecalculateListCostsDto) {
    const preview = await this.previewListCosts(ctx, dto.supplierId);
    if (preview.listDiscountPct === null) {
      throw new BadRequestException(
        'Este proveedor no tiene % de distribuidor: no hay con qué recalcular',
      );
    }
    const pct = preview.listDiscountPct;
    await this.prisma.$transaction(async (tx) => {
      for (const row of preview.changes) {
        await tx.retailProduct.update({
          where: { id: row.id },
          data: { costCOP: row.nextCostCOP, saleMarginPct: pct },
        });
        await tx.retailProductPriceHistory.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId: row.id,
            priceCOP: row.priceCOP,
            prevPriceCOP: row.priceCOP,
            costCOP: row.nextCostCOP,
            prevCostCOP: row.costCOP,
            reason: `Recalculado con el ${pct}% de ${preview.supplierName}`,
            userId: ctx.userId,
          },
        });
      }
    });
    return { updated: preview.changes.length };
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

  /**
   * El % de distribuidor del proveedor, validando de paso que sea de esta
   * tienda. Sin proveedor devuelve null. No filtra los archivados: un producto
   * que ya apuntaba a un proveedor que se dejó de usar tiene que poder seguir
   * guardándose.
   */
  private async supplierListPct(
    ctx: TenantContext,
    supplierId: string | null,
  ): Promise<number | null> {
    if (!supplierId) return null;
    const supplier = await this.prisma.retailSupplier.findFirst({
      where: { id: supplierId, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { listDiscountPct: true },
    });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    return supplier.listDiscountPct;
  }

  private async listSupplier(ctx: TenantContext, supplierId: string) {
    const supplier = await this.prisma.retailSupplier.findFirst({
      where: {
        id: supplierId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      select: { id: true, name: true, listDiscountPct: true },
    });
    if (!supplier) throw new NotFoundException('Proveedor no encontrado');
    return supplier;
  }

  /** Costo y % de un producto en modo LIST_DISCOUNT. */
  private listPricing(
    priceCOP: number,
    productPct: number | null | undefined,
    supplierPct: number | null,
  ) {
    const pct = effectiveListDiscountPct(productPct, supplierPct);
    if (pct === null) {
      throw new BadRequestException(
        'Para calcular el costo desde el precio de lista falta el % de ' +
          'descuento: ponlo en el producto o en el proveedor',
      );
    }
    return {
      pct,
      costCOP: costFromListPrice(priceCOP, pct),
      // El margen sobre el precio ES el descuento del distribuidor: de 285.000
      // quedan 85.500, que son el 30%.
      saleMarginPct: pct,
    };
  }

  /**
   * El vencimiento más cercano de lo que QUEDA, por producto y por aroma.
   *
   * Una sola agrupación para todo el listado, y solo sobre productos que
   * vencen: el resto del catálogo no paga esta consulta. Llave
   * `productId|variantId` (variante vacía = el producto entero), y además
   * `productId|*` con el mínimo de todo el producto, que es lo que pinta la
   * tarjeta del mostrador.
   */
  private async nextExpiryByKey(
    ctx: TenantContext,
    productIds: string[],
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (productIds.length === 0) return map;
    const rows = await this.prisma.retailStockLot.groupBy({
      by: ['productId', 'variantId'],
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: { in: productIds },
        qty: { gt: 0 },
      },
      _min: { expiresOn: true },
    });
    for (const row of rows) {
      if (!row._min.expiresOn) continue;
      const day = lotDay(row._min.expiresOn);
      map.set(`${row.productId}|${row.variantId ?? ''}`, day);
      const whole = map.get(`${row.productId}|*`);
      if (!whole || day < whole) map.set(`${row.productId}|*`, day);
    }
    return map;
  }

  private toProductDto(
    product: RetailProduct & {
      category?: { id: string; name: string; emoji: string | null } | null;
      variants?: ProductVariantRow[];
    },
    committedStock = 0,
    /**
     * `false` en el LISTADO: ahí las filas de reparto no las usa nadie —solo se pregunta si el
     * producto reparte y si alguna está en mínimo, y para eso están `variantCount` y
     * `hasLowStockVariant`—. Las filas completas las pide la pantalla del producto abierto, por
     * `GET /retail/products/:id`.
     *
     * Es lo que hace viable el reparto por varias opciones: 3 colores x 5 tallas son 15 filas por
     * producto, y multiplicado por el catálogo entero es un JSON de varios MB en cada apertura del
     * mostrador. Ver docs/PLAN_VARIANTES_MULTIDIMENSION_RETAIL.md §4.
     *
     * PARA REVERTIR: pasar `true` (o quitar el argumento) en `listProducts`. Nada más depende de esto.
     */
    includeVariants = true,
    /** Vencimientos más cercanos (ver `nextExpiryByKey`). Sin él, no viajan. */
    expiry?: Map<string, string>,
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
      // Cómo se le pone precio. COST_MARGIN es lo de siempre; en LIST_DISCOUNT
      // `costCOP` salió del precio y del % (el del producto, o si es null el
      // del proveedor `supplierId`).
      pricingMode: product.pricingMode,
      supplierId: product.supplierId,
      listDiscountPct: product.listDiscountPct,
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
      // Aparte de las fotos: se pintan distinto —hay que tocarlos para que
      // carguen— y pesan dos órdenes de magnitud más.
      videoUrls: product.videoUrls,
      primaryImageUrl: product.imageUrls[0] ?? null,
      trackStock: product.trackStock,
      tracksExpiry: product.tracksExpiry,
      expiryAlertDays: product.expiryAlertDays,
      // El lote con unidades que vence antes, de todo el producto. NULL = no
      // vence, o vence pero no tiene nada fechado todavía.
      nextExpiryOn: expiry?.get(`${product.id}|*`) ?? null,
      stock: product.stock,
      minStock: product.minStock,
      isLowStock:
        product.isActive &&
        product.trackStock &&
        product.stock <= product.minStock,
      // Vendido y sin entregar. NO se resta de `stock`: ese número tiene que
      // seguir coincidiendo con lo que hay al contar la estantería.
      committedStock,
      /** Lo que de verdad se puede vender hoy sin quedar mal con nadie. */
      availableStock: Math.max(0, product.stock - committedStock),
      // Reparto de existencias por opción. `stockOptionIds` vacío y `variants` vacío = el producto
      // cuenta entero, que es el caso por defecto.
      //
      // `stockOptionId` sigue viajando para los clientes que todavía no leen el array. Se deriva:
      // con varias dimensiones no hay UN grupo que quepa ahí, y mandar el primero sería mentir.
      stockOptionIds: product.stockOptionIds,
      stockOptionId:
        product.stockOptionIds.length === 1
          ? product.stockOptionIds[0]
          : product.stockOptionIds.length === 0
            ? null
            : product.stockOptionId,
      variants: includeVariants
        ? (product.variants ?? []).map((variant) => ({
            id: variant.id,
            optionValueId: variant.optionValueId,
            optionValueIds: variant.optionValueIds,
            combinationKey: variant.combinationKey,
            label: variant.label,
            sku: variant.sku,
            stock: variant.stock,
            minStock: variant.minStock,
            nextExpiryOn: expiry?.get(`${product.id}|${variant.id}`) ?? null,
            isLowStock:
              product.isActive &&
              product.trackStock &&
              variant.stock <= variant.minStock,
          }))
        : [],
      /**
       * Resumen del reparto, para que un LISTADO no necesite las filas completas.
       *
       * Las pantallas que muestran muchos productos solo preguntan "¿este reparte?" y "¿alguna de
       * sus filas está en mínimo?"; las filas completas únicamente las usa la pantalla del producto
       * que el usuario abrió. Con estos dos campos el listado deja de cargar con ellas.
       *
       * Importa de cara a las variantes de varias dimensiones: un producto con 3 colores × 5 tallas
       * son 15 filas, y multiplicado por un catálogo entero es un JSON de varios MB en cada apertura
       * del mostrador. Ver docs/PLAN_VARIANTES_MULTIDIMENSION_RETAIL.md §4.
       */
      variantCount: (product.variants ?? []).length,
      hasLowStockVariant:
        product.isActive &&
        product.trackStock &&
        (product.variants ?? []).some(
          (variant) => variant.stock <= variant.minStock,
        ),
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
