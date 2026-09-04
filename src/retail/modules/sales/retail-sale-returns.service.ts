import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, RetailReturnSettlement } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  costingCostCOP,
  weightedAverageCost,
} from '../../shared/retail-costing';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { CreateRetailSaleReturnDto } from './dto/retail-sale-return.dto';

const RETURN_INCLUDE = {
  items: true,
  sale: { select: { id: true, code: true, soldAt: true } },
} satisfies Prisma.RetailSaleReturnInclude;

type ReturnWithItems = Prisma.RetailSaleReturnGetPayload<{
  include: typeof RETURN_INCLUDE;
}>;

/**
 * [VERTICAL_RETAIL] Devoluciones y cambios del cliente.
 *
 * NO ES ANULAR. Anular dice "esa venta nunca debió existir" y la borra del día
 * en que se vendió; sirve para un error de digitación. Una devolución es un
 * hecho NUEVO, de otro día, sobre una venta que sí ocurrió: se vendió el 2 y el
 * 5 devolvieron 2 de las 6. La venta del 2 no se toca — si se tocara, un reporte
 * ya impreso dejaría de cuadrar.
 *
 * UNA SOLA OPERACIÓN PARA LOS TRES CASOS del mostrador —cambio parejo, cambio
 * por algo de otro valor, devolución del dinero— porque son la misma mecánica
 * con la diferencia en cero, negativa o positiva.
 *
 * LO QUE VUELVE ENTRA AL COSTO CONGELADO en la línea de la venta, no al promedio
 * de hoy: si entre medias entró mercancía más barata, reingresar al promedio
 * actual le cambiaría el costo a posteriori a algo que ya había salido y el
 * valor del inventario dejaría de cuadrar con lo que se pagó.
 */
@Injectable()
export class RetailSaleReturnsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  /** Las devoluciones de una venta, para verlas en su detalle. */
  async listBySale(ctx: TenantContext, saleId: string) {
    await this.tenantHelper.assertScopedRecord(
      'retailSale',
      ctx,
      saleId,
      'Sale',
    );
    const returns = await this.prisma.retailSaleReturn.findMany({
      where: { saleId },
      orderBy: { returnedAt: 'desc' },
      include: RETURN_INCLUDE,
    });
    return returns.map((row) => this.toDto(row));
  }

  /** Las del período. Es lo que finanzas resta del día en que ocurrieron. */
  async list(
    ctx: TenantContext,
    filters: { from?: string; to?: string; limit?: number } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const returns = await this.prisma.retailSaleReturn.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(filters.from || filters.to
          ? {
              returnedAt: {
                ...(filters.from ? { gte: new Date(filters.from) } : {}),
                ...(filters.to ? { lte: new Date(filters.to) } : {}),
              },
            }
          : {}),
      },
      orderBy: { returnedAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
      include: RETURN_INCLUDE,
    });
    return returns.map((row) => this.toDto(row));
  }

  /**
   * Registra la devolución y mueve todo en una sola transacción.
   *
   * Se valida ANTES de tocar nada: una devolución a medias dejaría stock movido
   * sin documento que lo explique, y eso no se puede deshacer desde la interfaz.
   */
  async create(
    ctx: TenantContext,
    saleId: string,
    dto: CreateRetailSaleReturnDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'retailSale',
      ctx,
      saleId,
      'Sale',
    );

    const created = await this.prisma.$transaction(async (tx) => {
      const sale = await tx.retailSale.findUniqueOrThrow({
        where: { id: saleId },
        include: { items: true },
      });
      if (sale.status === 'VOIDED') {
        throw new BadRequestException(
          'La venta está anulada: no hay nada que devolver',
        );
      }

      const itemById = new Map(sale.items.map((item) => [item.id, item]));

      // ─── Lo que vuelve ─────────────────────────────────────────────────────
      //
      // Se suma por línea antes de comparar: dos renglones de la misma línea con
      // aromas distintos son lo normal —devuelve 1 Sandía y 1 Melón— y
      // validarlos por separado dejaría pasar el doble de lo que se entregó.
      const returningByItem = new Map<string, number>();
      for (const line of dto.returnedItems) {
        const item = itemById.get(line.saleItemId);
        if (!item) {
          throw new BadRequestException(
            'Una de las líneas no pertenece a esta venta',
          );
        }
        returningByItem.set(
          line.saleItemId,
          (returningByItem.get(line.saleItemId) ?? 0) + line.quantity,
        );
      }
      for (const [itemId, quantity] of returningByItem) {
        const item = itemById.get(itemId)!;
        // El tope es lo ENTREGADO, no lo vendido: no se puede devolver algo que
        // nunca salió de la tienda. Y menos lo ya devuelto antes.
        const returnable = item.deliveredQty - item.returnedQty;
        if (quantity > returnable) {
          throw new BadRequestException(
            `De "${item.name}" se pueden devolver ${returnable}, no ${quantity}`,
          );
        }
      }

      // ─── Lo que se lleva a cambio ──────────────────────────────────────────
      const replacements = dto.replacementItems ?? [];
      const replacementProductIds = [
        ...new Set(replacements.map((line) => line.productId)),
      ];
      const replacementProducts = await tx.retailProduct.findMany({
        where: {
          id: { in: replacementProductIds },
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
        },
      });
      if (replacementProducts.length !== replacementProductIds.length) {
        throw new BadRequestException(
          'Hay productos que no existen en esta tienda',
        );
      }
      const productById = new Map(
        replacementProducts.map((product) => [product.id, product]),
      );

      // Mismo criterio que arriba: sumar por producto y por valor antes de
      // comparar contra el stock.
      const outByProduct = new Map<string, number>();
      const outByVariant = new Map<string, number>();
      for (const line of replacements) {
        const product = productById.get(line.productId)!;
        if (!product.trackStock) continue;
        outByProduct.set(
          line.productId,
          (outByProduct.get(line.productId) ?? 0) + line.quantity,
        );
        if (product.stockOptionId) {
          if (!line.variantId) {
            throw new BadRequestException(
              `"${product.name}" reparte existencias por opción: indica cuál se lleva`,
            );
          }
          outByVariant.set(
            line.variantId,
            (outByVariant.get(line.variantId) ?? 0) + line.quantity,
          );
        }
      }
      for (const [productId, quantity] of outByProduct) {
        const product = productById.get(productId)!;
        if (product.stock < quantity) {
          throw new BadRequestException(
            `No hay suficiente "${product.name}": hay ${product.stock}, se llevan ${quantity}`,
          );
        }
      }
      const outVariants = await tx.retailProductVariant.findMany({
        where: { id: { in: [...outByVariant.keys()] } },
      });
      const outVariantById = new Map(outVariants.map((row) => [row.id, row]));
      for (const [variantId, quantity] of outByVariant) {
        const variant = outVariantById.get(variantId);
        if (!variant || !productById.has(variant.productId)) {
          throw new BadRequestException(
            'La opción elegida no pertenece al producto que se lleva',
          );
        }
        if (variant.stock < quantity) {
          throw new BadRequestException(
            `No hay suficiente "${variant.label}": hay ${variant.stock}, se llevan ${quantity}`,
          );
        }
      }

      // ─── Ya validado: se mueve ─────────────────────────────────────────────
      const itemRows: Prisma.RetailSaleReturnItemCreateManyReturnInput[] = [];
      let returnedCOP = 0;
      let replacedCOP = 0;

      // Lo que vuelve. Agrupado por producto para que el kardex y el promedio se
      // muevan una sola vez por producto, con el stock encadenado.
      const inByProduct = new Map<
        string,
        { quantity: number; valueCOP: number }
      >();

      for (const line of dto.returnedItems) {
        const item = itemById.get(line.saleItemId)!;
        const lineTotal = item.unitPriceCOP * line.quantity;
        returnedCOP += lineTotal;

        itemRows.push({
          direction: 'IN',
          saleItemId: item.id,
          productId: item.productId,
          variantId: line.variantId ?? item.variantId ?? null,
          name: item.name,
          variantLabel: item.variantLabel,
          quantity: line.quantity,
          unitPriceCOP: item.unitPriceCOP,
          // El costo CON EL QUE SALIÓ, congelado en la venta.
          unitCostCOP: item.unitCostCOP,
        });

        const bucket = inByProduct.get(item.productId) ?? {
          quantity: 0,
          valueCOP: 0,
        };
        bucket.quantity += line.quantity;
        bucket.valueCOP += item.unitCostCOP * line.quantity;
        inByProduct.set(item.productId, bucket);

        await tx.retailSaleItem.update({
          where: { id: item.id },
          data: { returnedQty: { increment: line.quantity } },
        });

        const variantId = line.variantId ?? item.variantId;
        if (variantId) {
          await tx.retailProductVariant.update({
            where: { id: variantId },
            data: { stock: { increment: line.quantity } },
          });
        }
      }

      for (const [productId, bucket] of inByProduct) {
        const product = await tx.retailProduct.findUniqueOrThrow({
          where: { id: productId },
          select: {
            id: true,
            name: true,
            stock: true,
            trackStock: true,
            costCOP: true,
            avgCostCOP: true,
          },
        });
        if (!product.trackStock) continue;

        const unitCost = Math.round(bucket.valueCOP / bucket.quantity);
        const avgCostCOP = weightedAverageCost({
          stockBefore: product.stock,
          avgCostBefore: costingCostCOP(product),
          quantity: bucket.quantity,
          unitCostCOP: unitCost,
        });
        const stockAfter = product.stock + bucket.quantity;

        await tx.retailStockMovement.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId,
            type: 'RETURN',
            quantity: bucket.quantity,
            stockAfter,
            unitCostCOP: unitCost,
            reason: `Devolución del cliente · venta ${sale.code}`,
            reference: saleId,
            userId: ctx.userId,
          },
        });
        await tx.retailProduct.update({
          where: { id: productId },
          data: { stock: stockAfter, avgCostCOP },
        });
      }

      // Lo que se lleva. Sale al promedio vigente, como cualquier venta.
      for (const line of replacements) {
        const product = productById.get(line.productId)!;
        const unitPriceCOP = line.unitPriceCOP ?? product.priceCOP;
        replacedCOP += unitPriceCOP * line.quantity;

        const variant = line.variantId
          ? outVariantById.get(line.variantId)
          : undefined;

        itemRows.push({
          direction: 'OUT',
          saleItemId: null,
          productId: product.id,
          variantId: line.variantId ?? null,
          name: product.name,
          variantLabel: variant?.label ?? null,
          quantity: line.quantity,
          unitPriceCOP,
          unitCostCOP: costingCostCOP(product),
        });

        if (!product.trackStock) continue;

        const stockAfter = product.stock - line.quantity;
        await tx.retailStockMovement.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId: product.id,
            variantId: line.variantId ?? null,
            type: 'SALE',
            quantity: -line.quantity,
            stockAfter,
            unitCostCOP: costingCostCOP(product),
            reason: `Cambio · venta ${sale.code}`,
            reference: saleId,
            userId: ctx.userId,
          },
        });
        await tx.retailProduct.update({
          where: { id: product.id },
          data: { stock: stockAfter },
        });
        // Se refresca en memoria: dos líneas pueden ser del mismo producto y el
        // `stockAfter` del kardex tiene que ir encadenado.
        product.stock = stockAfter;

        if (line.variantId) {
          await tx.retailProductVariant.update({
            where: { id: line.variantId },
            data: { stock: { decrement: line.quantity } },
          });
        }
      }

      const balanceCOP = returnedCOP - replacedCOP;
      const settlement = dto.settlement ?? this.defaultSettlement(balanceCOP);

      const created = await tx.retailSaleReturn.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          code: await this.nextCode(tx, ctx.tenantId),
          saleId,
          customerId: sale.customerId,
          kind: replacements.length > 0 ? 'EXCHANGE' : 'REFUND',
          returnedCOP,
          replacedCOP,
          balanceCOP,
          settlement,
          paymentMethod: dto.paymentMethod ?? null,
          reason: dto.reason?.trim() || null,
          note: dto.note?.trim() || null,
          userId: ctx.userId,
        },
        select: { id: true },
      });
      await tx.retailSaleReturnItem.createMany({
        data: itemRows.map((row) => ({ ...row, returnId: created.id })),
      });

      return tx.retailSaleReturn.findUniqueOrThrow({
        where: { id: created.id },
        include: RETURN_INCLUDE,
      });
    }, this.txOptions);

    return this.toDto(created);
  }

  /**
   * Cómo se salda cuando no se dice. El caso sin sorpresas: si hay plata a favor
   * se devuelve, si falta se cobra. "Queda debiendo" y "no se devuelve" son
   * decisiones y hay que declararlas.
   */
  private defaultSettlement(balanceCOP: number): RetailReturnSettlement {
    if (balanceCOP === 0) return 'NONE';
    return balanceCOP > 0 ? 'REFUNDED' : 'CHARGED';
  }

  /** Consecutivo legible por tenant: DEV-000001. */
  private async nextCode(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    const last = await tx.retailSaleReturn.findFirst({
      where: { tenantId },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const lastNumber = last ? Number(last.code.replace(/\D/g, '')) : 0;
    return `DEV-${String(lastNumber + 1).padStart(6, '0')}`;
  }

  private toDto(row: ReturnWithItems) {
    return {
      id: row.id,
      code: row.code,
      saleId: row.saleId,
      saleCode: row.sale.code,
      saleSoldAt: row.sale.soldAt,
      customerId: row.customerId,
      kind: row.kind,
      returnedCOP: row.returnedCOP,
      replacedCOP: row.replacedCOP,
      balanceCOP: row.balanceCOP,
      settlement: row.settlement,
      paymentMethod: row.paymentMethod,
      reason: row.reason,
      note: row.note,
      returnedAt: row.returnedAt,
      /**
       * Lo que esta devolución le hace al ingreso del día en que ocurrió.
       * Negativo = ese día se vendió menos. Va resuelto acá para que finanzas y
       * el resumen de ventas no lo calculen cada uno por su lado.
       */
      revenueImpactCOP: row.replacedCOP - row.returnedCOP,
      items: row.items.map((item) => ({
        id: item.id,
        direction: item.direction,
        saleItemId: item.saleItemId,
        productId: item.productId,
        variantId: item.variantId,
        name: item.name,
        variantLabel: item.variantLabel,
        quantity: item.quantity,
        unitPriceCOP: item.unitPriceCOP,
        unitCostCOP: item.unitCostCOP,
      })),
    };
  }

  private readonly txOptions = { timeout: 20_000 };
}
