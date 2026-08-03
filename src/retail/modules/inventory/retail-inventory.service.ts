import { BadRequestException, Injectable } from '@nestjs/common';

import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { CreateStockMovementDto } from './dto/retail-inventory.dto';

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
      stockValueAtCostCOP += product.stock * product.costCOP;
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
  async createMovement(ctx: TenantContext, dto: CreateStockMovementDto) {
    await this.tenantHelper.assertScopedRecord(
      'retailProduct',
      ctx,
      dto.productId,
      'Product',
    );

    return this.prisma.$transaction(async (tx) => {
      const product = await tx.retailProduct.findUniqueOrThrow({
        where: { id: dto.productId },
        select: { stock: true, trackStock: true, name: true, costCOP: true },
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

      const movement = await tx.retailStockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: dto.productId,
          type: dto.type,
          quantity: dto.quantity,
          stockAfter,
          unitCostCOP: dto.unitCostCOP,
          reason: dto.reason,
          reference: dto.reference,
          userId: ctx.userId,
        },
      });

      await tx.retailProduct.update({
        where: { id: dto.productId },
        data: {
          stock: stockAfter,
          // Una compra con costo declarado actualiza el costo de referencia.
          ...(dto.type === 'PURCHASE' && dto.unitCostCOP !== undefined
            ? { costCOP: dto.unitCostCOP }
            : {}),
        },
      });

      return movement;
    }, this.txOptions);
  }

  private readonly txOptions = { timeout: 15_000 };
}
