import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, RetailSaleType } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { CreateRetailSaleDto, VoidRetailSaleDto } from './dto/retail-sale.dto';

/**
 * Clave de agrupación de stock: producto, y valor cuando el producto reparte.
 * Se serializa a string porque `Map` compara por identidad y una tupla no sirve
 * como clave.
 */
function stockKey(productId: string, variantId: string | null): string {
  return `${productId}|${variantId ?? ''}`;
}

function splitStockKey(key: string): {
  productId: string;
  variantId: string | null;
} {
  const [productId, variantId] = key.split('|');
  return { productId, variantId: variantId || null };
}

type SaleWithItems = Prisma.RetailSaleGetPayload<{
  include: {
    items: true;
    customer: { select: { id: true; name: true; phone: true } };
  };
}>;

@Injectable()
export class RetailSalesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  async listSales(
    ctx: TenantContext,
    filters: {
      from?: string;
      to?: string;
      limit?: number;
      saleType?: RetailSaleType;
    } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const sales = await this.prisma.retailSale.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(filters.saleType ? { saleType: filters.saleType } : {}),
        ...this.soldAtRange(filters.from, filters.to),
      },
      orderBy: { soldAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
      include: {
        items: true,
        customer: { select: { id: true, name: true, phone: true } },
      },
    });
    return sales.map((sale) => this.toSaleDto(sale));
  }

  async getSale(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');
    const sale = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id },
      include: {
        items: true,
        customer: { select: { id: true, name: true, phone: true } },
      },
    });
    return this.toSaleDto(sale);
  }

  /** Totales del día/rango para el dashboard de la tienda. */
  async getSummary(
    ctx: TenantContext,
    from?: string,
    to?: string,
    saleType?: RetailSaleType,
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const sales = await this.prisma.retailSale.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: 'COMPLETED',
        ...(saleType ? { saleType } : {}),
        ...this.soldAtRange(from, to),
      },
      select: {
        totalCOP: true,
        costCOP: true,
        paymentMethod: true,
        saleType: true,
        items: { select: { quantity: true } },
      },
    });

    const revenueCOP = sales.reduce((sum, sale) => sum + sale.totalCOP, 0);
    const costCOP = sales.reduce((sum, sale) => sum + sale.costCOP, 0);
    const unitsSold = sales.reduce(
      (sum, sale) => sum + sale.items.reduce((n, item) => n + item.quantity, 0),
      0,
    );
    const byPaymentMethod: Record<string, number> = {};
    for (const sale of sales) {
      byPaymentMethod[sale.paymentMethod] =
        (byPaymentMethod[sale.paymentMethod] ?? 0) + sale.totalCOP;
    }

    // Desglose normal vs mayorista. Va con costo y margen propios, no solo con
    // ingresos: el punto de separarlos es poder ver que el mayorista factura
    // más y deja menos por unidad, y eso solo se ve comparando márgenes.
    const bySaleType = {
      RETAIL: this.emptyTypeBucket(),
      WHOLESALE: this.emptyTypeBucket(),
    };
    for (const sale of sales) {
      const bucket = bySaleType[sale.saleType];
      bucket.salesCount += 1;
      bucket.revenueCOP += sale.totalCOP;
      bucket.costCOP += sale.costCOP;
      bucket.unitsSold += sale.items.reduce((n, item) => n + item.quantity, 0);
    }
    for (const bucket of Object.values(bySaleType)) {
      bucket.grossProfitCOP = bucket.revenueCOP - bucket.costCOP;
      bucket.marginPct = this.marginPct(bucket.revenueCOP, bucket.costCOP);
      bucket.averageTicketCOP = bucket.salesCount
        ? Math.round(bucket.revenueCOP / bucket.salesCount)
        : 0;
    }

    return {
      salesCount: sales.length,
      revenueCOP,
      costCOP,
      grossProfitCOP: revenueCOP - costCOP,
      marginPct: this.marginPct(revenueCOP, costCOP),
      unitsSold,
      averageTicketCOP: sales.length
        ? Math.round(revenueCOP / sales.length)
        : 0,
      byPaymentMethod,
      bySaleType,
    };
  }

  private emptyTypeBucket() {
    return {
      salesCount: 0,
      revenueCOP: 0,
      costCOP: 0,
      grossProfitCOP: 0,
      marginPct: 0,
      unitsSold: 0,
      averageTicketCOP: 0,
    };
  }

  private marginPct(revenueCOP: number, costCOP: number): number {
    if (revenueCOP <= 0) return 0;
    return Math.round(((revenueCOP - costCOP) / revenueCOP) * 1000) / 10;
  }

  /**
   * Cobra una venta de mostrador. Todo ocurre en una transacción:
   * valida stock → descuenta → deja kardex → congela costo → numera la venta.
   * Si algo falla, no queda ni stock movido ni venta a medias.
   */
  async createSale(ctx: TenantContext, dto: CreateRetailSaleDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    if (dto.customerId) {
      await this.tenantHelper.assertScopedRecord(
        'retailCustomer',
        ctx,
        dto.customerId,
        'Customer',
      );
    }

    const productIds = [...new Set(dto.items.map((item) => item.productId))];

    const sale = await this.prisma.$transaction(async (tx) => {
      const products = await tx.retailProduct.findMany({
        where: {
          id: { in: productIds },
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
        },
      });
      if (products.length !== productIds.length) {
        throw new BadRequestException(
          'Hay productos que no existen en esta tienda',
        );
      }
      const byId = new Map(products.map((product) => [product.id, product]));

      const variants = await tx.retailProductVariant.findMany({
        where: { productId: { in: productIds } },
      });
      const variantById = new Map(
        variants.map((variant) => [variant.id, variant]),
      );

      // Un producto que reparte no se puede vender "en general": habría que
      // adivinar de qué aroma descontar, y el reparto quedaría descuadrado
      // contra el total sin forma de saber quién se movió.
      for (const item of dto.items) {
        const product = byId.get(item.productId)!;
        if (!product.stockOptionId || !product.trackStock) continue;
        if (!item.variantId) {
          throw new BadRequestException(
            `"${product.name}" reparte existencias por opción: indica cuál se vende`,
          );
        }
        const variant = variantById.get(item.variantId);
        if (!variant || variant.productId !== product.id) {
          throw new BadRequestException(
            `La opción elegida no pertenece a "${product.name}"`,
          );
        }
      }

      // Se agrupa por producto y valor: dos líneas del mismo ítem deben validar
      // el stock sumado, y dos aromas distintos validan contra filas distintas.
      const requestedQty = new Map<string, number>();
      for (const item of dto.items) {
        const key = stockKey(item.productId, item.variantId ?? null);
        requestedQty.set(key, (requestedQty.get(key) ?? 0) + item.quantity);
      }

      const productQty = new Map<string, number>();
      for (const [key, quantity] of requestedQty) {
        const { productId } = splitStockKey(key);
        productQty.set(productId, (productQty.get(productId) ?? 0) + quantity);
      }

      for (const [productId, quantity] of productQty) {
        const product = byId.get(productId)!;
        if (!product.isActive) {
          throw new BadRequestException(`"${product.name}" no está disponible`);
        }
        if (product.trackStock && product.stock < quantity) {
          throw new BadRequestException(
            `Stock insuficiente de "${product.name}": hay ${product.stock}, se piden ${quantity}`,
          );
        }
      }

      for (const [key, quantity] of requestedQty) {
        const { productId, variantId } = splitStockKey(key);
        if (!variantId || !byId.get(productId)!.trackStock) continue;
        const variant = variantById.get(variantId)!;
        if (variant.stock < quantity) {
          const product = byId.get(productId)!;
          throw new BadRequestException(
            `Stock insuficiente de "${product.name} · ${variant.label}": hay ${variant.stock}, se piden ${quantity}`,
          );
        }
      }

      const items = dto.items.map((item) => {
        const product = byId.get(item.productId)!;
        const unitPriceCOP = item.unitPriceCOP ?? product.priceCOP;
        const discountCOP = item.discountCOP ?? 0;
        const totalCOP = unitPriceCOP * item.quantity - discountCOP;
        if (totalCOP < 0) {
          throw new BadRequestException(
            `El descuento de "${product.name}" supera el valor de la línea`,
          );
        }
        const variant = item.variantId
          ? variantById.get(item.variantId)
          : undefined;
        return {
          productId: product.id,
          variantId: variant?.id ?? null,
          // Congelada en la línea: el recibo tiene que seguir diciendo "Arrurú"
          // aunque después se borre o renombre el aroma.
          variantLabel: variant?.label ?? null,
          name: product.name,
          sku: product.sku,
          quantity: item.quantity,
          unitPriceCOP,
          unitCostCOP: product.costCOP,
          discountCOP,
          totalCOP,
        };
      });

      const subtotalCOP = items.reduce((sum, item) => sum + item.totalCOP, 0);
      const saleDiscountCOP = dto.discountCOP ?? 0;
      const totalCOP = subtotalCOP - saleDiscountCOP;
      if (totalCOP < 0) {
        throw new BadRequestException(
          'El descuento supera el total de la venta',
        );
      }
      const costCOP = items.reduce(
        (sum, item) => sum + item.unitCostCOP * item.quantity,
        0,
      );

      if (dto.receivedCOP !== undefined && dto.receivedCOP < totalCOP) {
        throw new BadRequestException(
          `El efectivo recibido (${dto.receivedCOP}) es menor al total (${totalCOP})`,
        );
      }

      const created = await tx.retailSale.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          code: await this.nextSaleCode(tx, ctx.tenantId),
          customerId: dto.customerId,
          userId: ctx.userId,
          cashSessionId: dto.cashSessionId,
          subtotalCOP,
          discountCOP: saleDiscountCOP,
          totalCOP,
          costCOP,
          paymentMethod: dto.paymentMethod ?? 'CASH',
          saleType: dto.saleType ?? 'RETAIL',
          receivedCOP: dto.receivedCOP,
          changeCOP:
            dto.receivedCOP !== undefined ? dto.receivedCOP - totalCOP : null,
          note: dto.note,
          items: { create: items },
        },
        include: {
          items: true,
          customer: { select: { id: true, name: true, phone: true } },
        },
      });

      await this.applyStockDelta(tx, ctx, created.id, requestedQty, byId, -1);

      if (dto.customerId) {
        await tx.retailCustomer.update({
          where: { id: dto.customerId },
          data: {
            totalSpentCOP: { increment: totalCOP },
            salesCount: { increment: 1 },
            lastPurchaseAt: created.soldAt,
          },
        });
      }

      return created;
    }, this.txOptions);

    return this.toSaleDto(sale);
  }

  /** Anula una venta: devuelve el stock al inventario y la saca de finanzas. */
  async voidSale(ctx: TenantContext, id: string, dto: VoidRetailSaleDto) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const sale = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.retailSale.findUniqueOrThrow({
        where: { id },
        include: { items: true },
      });
      if (existing.status === 'VOIDED') {
        throw new BadRequestException('La venta ya está anulada');
      }

      // Se devuelve a la misma fila de la que salió: anular una venta de Arrurú
      // no puede reingresar la unidad como Sandía.
      const returnedQty = new Map<string, number>();
      for (const item of existing.items) {
        const key = stockKey(item.productId, item.variantId);
        returnedQty.set(key, (returnedQty.get(key) ?? 0) + item.quantity);
      }
      const productIds = [
        ...new Set(
          [...returnedQty.keys()].map((key) => splitStockKey(key).productId),
        ),
      ];
      const products = await tx.retailProduct.findMany({
        where: { id: { in: productIds } },
      });
      const byId = new Map(products.map((product) => [product.id, product]));

      await this.applyStockDelta(tx, ctx, existing.id, returnedQty, byId, 1);

      if (existing.customerId) {
        await tx.retailCustomer.update({
          where: { id: existing.customerId },
          data: {
            totalSpentCOP: { decrement: existing.totalCOP },
            salesCount: { decrement: 1 },
          },
        });
      }

      return tx.retailSale.update({
        where: { id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedReason: dto.reason,
        },
        include: {
          items: true,
          customer: { select: { id: true, name: true, phone: true } },
        },
      });
    }, this.txOptions);

    return this.toSaleDto(sale);
  }

  /**
   * Mueve stock y escribe kardex para cada línea de una venta.
   * `direction` = -1 al vender, +1 al anular.
   *
   * Agrupa por producto Y valor: dos líneas del mismo producto con aromas
   * distintos son dos movimientos distintos, porque descuentan de filas de
   * inventario distintas. El total del producto se mueve igual en ambos casos —
   * la fila del aroma dice cuáles unidades salieron, no cuántas hay en total.
   */
  private async applyStockDelta(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    saleId: string,
    quantities: Map<string, number>,
    products: Map<
      string,
      { stock: number; trackStock: boolean; costCOP: number }
    >,
    direction: 1 | -1,
  ) {
    // Se acumula por producto para no pisar el `stock` con dos updates seguidos
    // que hayan leído el mismo valor de partida.
    const productDelta = new Map<string, number>();
    for (const [key, quantity] of quantities) {
      const { productId } = splitStockKey(key);
      productDelta.set(
        productId,
        (productDelta.get(productId) ?? 0) + quantity * direction,
      );
    }

    for (const [productId, delta] of productDelta) {
      const product = products.get(productId);
      if (!product?.trackStock) continue;
      await tx.retailProduct.update({
        where: { id: productId },
        data: { stock: product.stock + delta },
      });
    }

    for (const [key, quantity] of quantities) {
      const { productId, variantId } = splitStockKey(key);
      const product = products.get(productId);
      if (!product?.trackStock) continue;

      if (variantId) {
        await tx.retailProductVariant.update({
          where: { id: variantId },
          data: { stock: { increment: quantity * direction } },
        });
      }

      await tx.retailStockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId,
          variantId,
          type: direction === -1 ? 'SALE' : 'RETURN',
          quantity: quantity * direction,
          // El total del producto ya quedó movido arriba, así que este es el
          // valor final para todas las líneas del mismo producto.
          stockAfter: product.stock + (productDelta.get(productId) ?? 0),
          unitCostCOP: product.costCOP,
          reason: direction === -1 ? 'Venta' : 'Anulación de venta',
          reference: saleId,
          userId: ctx.userId,
        },
      });
    }
  }

  /** Consecutivo legible por tenant: RS-000001. */
  private async nextSaleCode(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    const last = await tx.retailSale.findFirst({
      where: { tenantId },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const lastNumber = last ? Number(last.code.replace(/\D/g, '')) : 0;
    return `RS-${String(lastNumber + 1).padStart(6, '0')}`;
  }

  private soldAtRange(from?: string, to?: string) {
    if (!from && !to) return {};
    return {
      soldAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      },
    };
  }

  private toSaleDto(sale: SaleWithItems) {
    return {
      id: sale.id,
      code: sale.code,
      tenantId: sale.tenantId,
      branchId: sale.branchId,
      status: sale.status,
      saleType: sale.saleType,
      customerId: sale.customerId,
      customerName: sale.customer?.name ?? null,
      customerPhone: sale.customer?.phone ?? null,
      userId: sale.userId,
      cashSessionId: sale.cashSessionId,
      subtotalCOP: sale.subtotalCOP,
      discountCOP: sale.discountCOP,
      totalCOP: sale.totalCOP,
      costCOP: sale.costCOP,
      grossProfitCOP: sale.totalCOP - sale.costCOP,
      paymentMethod: sale.paymentMethod,
      receivedCOP: sale.receivedCOP,
      changeCOP: sale.changeCOP,
      note: sale.note,
      soldAt: sale.soldAt,
      voidedAt: sale.voidedAt,
      voidedReason: sale.voidedReason,
      items: sale.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        variantId: item.variantId,
        variantLabel: item.variantLabel,
        name: item.name,
        sku: item.sku,
        quantity: item.quantity,
        unitPriceCOP: item.unitPriceCOP,
        unitCostCOP: item.unitCostCOP,
        discountCOP: item.discountCOP,
        totalCOP: item.totalCOP,
      })),
    };
  }

  private readonly txOptions = { timeout: 20_000 };
}
