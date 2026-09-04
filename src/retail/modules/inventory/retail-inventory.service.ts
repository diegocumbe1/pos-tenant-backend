import { BadRequestException, Injectable } from '@nestjs/common';

import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  costingCostCOP,
  weightedAverageCost,
} from '../../shared/retail-costing';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { setVariantDistribution } from '../../shared/retail-product-variants';
import {
  CreateRetailStockMovementDto,
  SetVariantDistributionDto,
} from './dto/retail-inventory.dto';

@Injectable()
export class RetailInventoryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  /** Kardex de la tienda, opcionalmente filtrado por producto. */
  async listMovements(
    ctx: TenantContext,
    filters: { productId?: string; limit?: number } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const movements = await this.prisma.retailStockMovement.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: filters.productId,
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
      include: { product: { select: { id: true, name: true, sku: true } } },
    });
    return movements.map((movement) => ({
      id: movement.id,
      productId: movement.productId,
      productName: movement.product.name,
      productSku: movement.product.sku,
      type: movement.type,
      quantity: movement.quantity,
      stockAfter: movement.stockAfter,
      unitCostCOP: movement.unitCostCOP,
      reason: movement.reason,
      reference: movement.reference,
      userId: movement.userId,
      createdAt: movement.createdAt,
    }));
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

      const movement = await tx.retailStockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: dto.productId,
          variantId: variant?.id ?? null,
          type: dto.type,
          quantity: dto.quantity,
          stockAfter,
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

      await setVariantDistribution(tx, {
        productId,
        productName: product.name,
        productStock: product.stock,
        items: dto.items,
      });

      return tx.retailProductVariant.findMany({
        where: { productId },
        orderBy: { createdAt: 'asc' },
      });
    }, this.txOptions);
  }

  private readonly txOptions = { timeout: 15_000 };
}
