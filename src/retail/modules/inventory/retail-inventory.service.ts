import { BadRequestException, Injectable } from '@nestjs/common';
import { RetailPurchaseStatus, RetailStockMovementType } from '@prisma/client';

import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  costingCostCOP,
  weightedAverageCost,
} from '../../shared/retail-costing';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { setVariantDistribution } from '../../shared/retail-product-variants';
import {
  applyBalanceDelta,
  applySignedDelta,
  resolveLocation,
} from '../../shared/retail-stock-locations';
import {
  CreateRetailStockMovementDto,
  SetVariantDistributionDto,
} from './dto/retail-inventory.dto';

/**
 * Cómo se lee cada movimiento en el histórico del producto. Van aquí y no en la
 * pantalla porque el histórico mezcla cuatro fuentes y el texto tiene que quedar
 * armado en el mismo sitio donde se decide el orden.
 */
const MOVEMENT_TITLES: Record<RetailStockMovementType, string> = {
  INITIAL: 'Carga inicial',
  PURCHASE: 'Entrada por compra',
  SALE: 'Salida por venta',
  RETURN: 'Devolución',
  ADJUSTMENT: 'Ajuste de conteo',
  LOSS: 'Pérdida',
  TRANSFER: 'Traslado entre bodegas',
};

const PURCHASE_STATUS_LABELS: Record<RetailPurchaseStatus, string> = {
  PENDING: 'por pedir',
  ORDERED: 'pedido',
  PARTIALLY_RECEIVED: 'llegó una parte',
  RECEIVED: 'recibido',
  CANCELLED: 'cancelado',
};

@Injectable()
export class RetailInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  /**
   * Kardex de la tienda, opcionalmente filtrado por producto o por bodega.
   *
   * Filtrar por bodega devuelve las filas cuyo SALDO movió esa bodega, no las
   * que la mencionan: un traslado deja dos filas, una en cada extremo, así que
   * el kardex de cada sitio cuadra por sí solo sin tener que leer la columna de
   * destino para saber si esa fila le sumaba o le restaba.
   */
  async listMovements(
    ctx: TenantContext,
    filters: {
      productId?: string;
      locationId?: string;
      type?: RetailStockMovementType;
      limit?: number;
    } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const movements = await this.prisma.retailStockMovement.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: filters.productId,
        locationId: filters.locationId,
        type: filters.type,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
      include: {
        product: { select: { id: true, name: true, sku: true } },
        variant: { select: { id: true, label: true } },
        location: { select: { id: true, name: true } },
        toLocation: { select: { id: true, name: true } },
      },
    });
    return movements.map((movement) => ({
      id: movement.id,
      productId: movement.productId,
      productName: movement.product.name,
      productSku: movement.product.sku,
      variantId: movement.variantId,
      variantLabel: movement.variant?.label ?? null,
      type: movement.type,
      quantity: movement.quantity,
      stockAfter: movement.stockAfter,
      locationId: movement.locationId,
      locationName: movement.location?.name ?? null,
      toLocationId: movement.toLocationId,
      toLocationName: movement.toLocation?.name ?? null,
      unitCostCOP: movement.unitCostCOP,
      reason: movement.reason,
      reference: movement.reference,
      userId: movement.userId,
      createdAt: movement.createdAt,
    }));
  }

  /**
   * TODO lo que le ha pasado a un producto, en una sola línea de tiempo.
   *
   * El kardex solo cuenta la mitad: dice que entraron 12 pero no a cuánto se
   * pidieron, ni a quién se vendieron, ni que el precio subió en medio. Hacer un
   * inventario de verdad —"¿esto por qué me está dejando menos?"— exige poder
   * leer las tres cosas juntas y en orden.
   *
   * Se arma en el servidor y no en la pantalla porque son cuatro consultas a
   * tablas distintas que hay que intercalar por fecha; hacerlo en el cliente
   * obligaría a traerlas enteras.
   */
  async productHistory(
    ctx: TenantContext,
    productId: string,
    opts: { limit?: number } = {},
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailProduct',
      ctx,
      productId,
      'Product',
    );
    const take = Math.min(opts.limit ?? 120, 400);
    const scope = { tenantId: ctx.tenantId, branchId: ctx.branchId };

    const [movements, saleItems, priceChanges, purchases] = await Promise.all([
      this.prisma.retailStockMovement.findMany({
        where: { ...scope, productId },
        orderBy: { createdAt: 'desc' },
        take,
        include: {
          variant: { select: { label: true } },
          location: { select: { id: true, name: true } },
          toLocation: { select: { id: true, name: true } },
        },
      }),
      this.prisma.retailSaleItem.findMany({
        where: { productId, sale: { ...scope } },
        orderBy: { sale: { soldAt: 'desc' } },
        take,
        include: {
          sale: {
            select: {
              id: true,
              code: true,
              soldAt: true,
              status: true,
              customer: { select: { name: true } },
            },
          },
          location: { select: { id: true, name: true } },
        },
      }),
      this.prisma.retailProductPriceHistory.findMany({
        where: { tenantId: ctx.tenantId, productId },
        orderBy: { createdAt: 'desc' },
        take,
      }),
      this.prisma.retailPurchaseItem.findMany({
        where: { ...scope, productId },
        orderBy: { createdAt: 'desc' },
        take,
        include: { supplierRef: { select: { name: true } } },
      }),
    ]);

    type Entry = {
      id: string;
      kind: 'movement' | 'sale' | 'price' | 'purchase';
      at: Date;
      title: string;
      detail: string | null;
      quantity: number | null;
      amountCOP: number | null;
      locationId: string | null;
      locationName: string | null;
      reference: string | null;
    };

    const entries: Entry[] = [];

    for (const m of movements) {
      const variant = m.variant ? ` · ${m.variant.label}` : '';
      entries.push({
        id: `mov_${m.id}`,
        kind: 'movement',
        at: m.createdAt,
        title: `${MOVEMENT_TITLES[m.type]}${variant}`,
        detail:
          m.type === 'TRANSFER' && m.toLocation
            ? m.quantity < 0
              ? `Salió hacia ${m.toLocation.name}`
              : `Entró desde ${m.toLocation.name}`
            : m.reason,
        quantity: m.quantity,
        amountCOP: m.unitCostCOP,
        locationId: m.locationId,
        locationName: m.location?.name ?? null,
        reference: m.reference,
      });
    }

    for (const item of saleItems) {
      const variant = item.variantLabel ? ` · ${item.variantLabel}` : '';
      entries.push({
        id: `sale_${item.id}`,
        kind: 'sale',
        at: item.sale.soldAt,
        title: `Venta ${item.sale.code}${variant}`,
        detail:
          [
            item.sale.customer?.name,
            item.sale.status === 'VOIDED' ? 'ANULADA' : null,
          ]
            .filter(Boolean)
            .join(' · ') || null,
        quantity: -item.quantity,
        amountCOP: item.unitPriceCOP,
        locationId: item.locationId,
        locationName: item.location?.name ?? null,
        reference: item.sale.id,
      });
    }

    for (const change of priceChanges) {
      const movedPrice =
        change.prevPriceCOP !== null && change.prevPriceCOP !== change.priceCOP;
      const movedCost =
        change.prevCostCOP !== null && change.prevCostCOP !== change.costCOP;
      entries.push({
        id: `price_${change.id}`,
        kind: 'price',
        at: change.createdAt,
        title: movedPrice
          ? 'Cambio de precio'
          : movedCost
            ? 'Cambio de costo'
            : 'Precio registrado',
        detail:
          change.reason ??
          ([
            movedPrice
              ? `Precio ${change.prevPriceCOP} → ${change.priceCOP}`
              : null,
            movedCost
              ? `Costo ${change.prevCostCOP} → ${change.costCOP}`
              : null,
          ]
            .filter(Boolean)
            .join(' · ') ||
            null),
        quantity: null,
        amountCOP: change.priceCOP,
        locationId: null,
        locationName: null,
        reference: null,
      });
    }

    for (const purchase of purchases) {
      entries.push({
        id: `pur_${purchase.id}`,
        kind: 'purchase',
        at: purchase.createdAt,
        title: `Pedido a proveedor · ${PURCHASE_STATUS_LABELS[purchase.status]}`,
        detail:
          purchase.supplierRef?.name ?? purchase.supplier ?? purchase.name,
        // Lo recibido cuando ya llegó; lo pedido mientras se espera.
        quantity: purchase.receivedQuantity ?? purchase.quantity,
        amountCOP: purchase.receivedUnitCostCOP ?? purchase.estimatedCostCOP,
        locationId: null,
        locationName: null,
        reference: purchase.id,
      });
    }

    return entries
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .slice(0, take);
  }

  /** Resumen de inventario: valor a costo, valor a precio y alertas de stock bajo. */
  async getSummary(ctx: TenantContext) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const products = await this.prisma.retailProduct.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        trackStock: true,
      },
      select: {
        id: true,
        name: true,
        sku: true,
        stock: true,
        minStock: true,
        costCOP: true,
        avgCostCOP: true,
        priceCOP: true,
      },
    });

    let stockValueAtCostCOP = 0;
    let stockValueAtPriceCOP = 0;
    let totalUnits = 0;
    const lowStock: Array<{
      id: string;
      name: string;
      sku: string | null;
      stock: number;
      minStock: number;
    }> = [];

    for (const product of products) {
      // Al PROMEDIO y no al costo de reposición: el inventario vale lo que se
      // pagó por lo que hay, no lo que costaría volver a comprarlo.
      stockValueAtCostCOP += product.stock * costingCostCOP(product);
      stockValueAtPriceCOP += product.stock * product.priceCOP;
      totalUnits += product.stock;
      if (product.stock <= product.minStock) {
        lowStock.push({
          id: product.id,
          name: product.name,
          sku: product.sku,
          stock: product.stock,
          minStock: product.minStock,
        });
      }
    }

    return {
      trackedProducts: products.length,
      totalUnits,
      stockValueAtCostCOP,
      stockValueAtPriceCOP,
      potentialMarginCOP: stockValueAtPriceCOP - stockValueAtCostCOP,
      lowStockCount: lowStock.length,
      lowStock: lowStock.sort((a, b) => a.stock - b.stock).slice(0, 50),
    };
  }

  /**
   * Registra un movimiento manual (compra, devolución, ajuste, pérdida) y deja
   * el stock del producto en el mismo commit: stock y kardex nunca divergen.
   */
  async createMovement(ctx: TenantContext, dto: CreateRetailStockMovementDto) {
    await this.tenantHelper.assertScopedRecord(
      'retailProduct',
      ctx,
      dto.productId,
      'Product',
    );

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.retailProduct.findUniqueOrThrow({
        where: { id: dto.productId },
        select: {
          stock: true,
          trackStock: true,
          name: true,
          costCOP: true,
          avgCostCOP: true,
          stockOptionId: true,
        },
      });
      if (!product.trackStock) {
        throw new BadRequestException(
          `"${product.name}" no controla stock (trackStock=false)`,
        );
      }

      const stockAfter = product.stock + dto.quantity;
      if (stockAfter < 0) {
        throw new BadRequestException(
          `Stock insuficiente de "${product.name}": hay ${product.stock}, se intentan sacar ${Math.abs(dto.quantity)}`,
        );
      }

      // Movimiento dirigido a un valor concreto (llegaron 6 de Arrurú). Mueve
      // la fila del aroma Y el total del producto: el total sigue siendo la
      // suma de lo que hay en la tienda, reparta o no.
      let variant: { id: string; label: string; stock: number } | null = null;
      if (dto.variantId) {
        variant = await tx.retailProductVariant.findFirst({
          where: { id: dto.variantId, productId: dto.productId },
          select: { id: true, label: true, stock: true },
        });
        if (!variant) {
          throw new BadRequestException(
            `El valor indicado no pertenece a "${product.name}"`,
          );
        }
        if (variant.stock + dto.quantity < 0) {
          throw new BadRequestException(
            `Stock insuficiente de "${product.name} · ${variant.label}": hay ${variant.stock}, se intentan sacar ${Math.abs(dto.quantity)}`,
          );
        }
      } else if (product.stockOptionId && dto.quantity < 0) {
        // Una salida sin decir de cuál aroma dejaría el total y el reparto
        // descuadrados sin forma de saber a quién descontarle.
        throw new BadRequestException(
          `"${product.name}" reparte existencias por opción: indica de cuál valor sale la mercancía`,
        );
      }

      // Dónde queda (o de dónde sale) la mercancía. Sin bodega elegida entra a
      // la principal; una salida sin elegir sale de donde haya, empezando por
      // la principal.
      const locationId = await applySignedDelta(tx, ctx, {
        productId: dto.productId,
        variantId: variant?.id ?? null,
        delta: dto.quantity,
        locationId: dto.locationId,
      });

      const movement = await tx.retailStockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: dto.productId,
          variantId: variant?.id ?? null,
          type: dto.type,
          quantity: dto.quantity,
          stockAfter,
          locationId,
          unitCostCOP: dto.unitCostCOP,
          reason: dto.reason,
          reference: dto.reference,
          userId: ctx.userId,
        },
      });

      if (variant) {
        await tx.retailProductVariant.update({
          where: { id: variant.id },
          data: { stock: { increment: dto.quantity } },
        });
      }

      await tx.retailProduct.update({
        where: { id: dto.productId },
        data: {
          stock: stockAfter,
          // Solo las ENTRADAS mueven el promedio, y solo si vienen con costo:
          // un ajuste por conteo que suma unidades sin decir a cuánto entraron
          // no aporta información de costo, así que el promedio se queda igual
          // y esas unidades quedan valoradas al promedio vigente.
          ...(dto.quantity > 0 && dto.unitCostCOP !== undefined
            ? {
                avgCostCOP: weightedAverageCost({
                  stockBefore: product.stock,
                  avgCostBefore: product.avgCostCOP ?? product.costCOP,
                  quantity: dto.quantity,
                  unitCostCOP: dto.unitCostCOP,
                }),
              }
            : {}),
          // Una compra con costo declarado actualiza el costo de reposición.
          ...(dto.type === 'PURCHASE' && dto.unitCostCOP !== undefined
            ? { costCOP: dto.unitCostCOP }
            : {}),
        },
      });

      return movement;
    }, this.txOptions);
  }

  /**
   * Reparte el total existente entre los valores del grupo que lleva stock.
   *
   * Es un CONTEO, no un movimiento: contar cuántas de las 11 mantequillas son
   * de Arrurú no hace entrar ni salir mercancía de la tienda, así que no genera
   * kardex y el total no cambia. Para que entre o salga está `createMovement`,
   * que sí deja rastro.
   */
  async setDistribution(
    ctx: TenantContext,
    productId: string,
    dto: SetVariantDistributionDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailProduct',
      ctx,
      productId,
      'Product',
    );

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.retailProduct.findUniqueOrThrow({
        where: { id: productId },
        select: { name: true, stock: true },
      });

      const deltas = await setVariantDistribution(tx, {
        productId,
        productName: product.name,
        productStock: product.stock,
        items: dto.items,
      });

      // Repartir no hace entrar ni salir mercancía, pero SÍ mueve el saldo de
      // un renglón a otro: las unidades pasan de "sin repartir" a un aroma
      // concreto. Se hace contra la bodega elegida —la principal por defecto—
      // porque lo que nadie había repartido es justamente lo que figura en la
      // casa. Sin esto, los saldos por bodega dejarían de sumar el total.
      const locationId = await resolveLocation(tx, ctx, dto.locationId);
      for (const { variantId, delta } of deltas) {
        await applyBalanceDelta(
          tx,
          ctx,
          { locationId, productId, variantId },
          delta,
        );
        await applyBalanceDelta(
          tx,
          ctx,
          { locationId, productId, variantId: null },
          -delta,
        );
      }

      return tx.retailProductVariant.findMany({
        where: { productId },
        orderBy: { createdAt: 'asc' },
      });
    }, this.txOptions);
  }

  private readonly txOptions = { timeout: 15_000 };
}
