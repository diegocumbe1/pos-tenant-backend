import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, RetailStockCountLine } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  AllyTier,
  allyDiscountPct,
  normalizeAllyTiers,
} from '../../shared/retail-ally-tiers';
import {
  applySignedDelta,
  ensureDefaultLocation,
} from '../../shared/retail-stock-locations';
import { RetailSalesService } from '../sales/retail-sales.service';
import {
  CloseRetailStockCountDto,
  LinkRetailStockCountSaleDto,
  UpdateAllySettingsDto,
  UpdateRetailStockCountDto,
} from './dto/retail-stock-count.dto';
import { RetailLocationsService } from './retail-locations.service';

type Tx = Prisma.TransactionClient;

/** Cómo cierra una revista, según el sitio. */
type CountMode = 'PRINCIPAL' | 'EXHIBITION' | 'ALLY';

/**
 * [VERTICAL_RETAIL] Revistas: el conteo físico de una bodega en una fecha.
 *
 * Ver docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md §4–5 (pos-system).
 *
 * PENSADA PARA SER RÁPIDA. Se abre precargada con lo que el sistema espera que
 * haya y solo se tocan los renglones que no coinciden: un renglón sin tocar
 * cuenta como "está igual". Se guarda como borrador mientras se cuenta, así que
 * si se cae la señal se retoma donde iba.
 *
 * AL CERRAR, la diferencia se aplica según el sitio:
 *   - Principal: un AJUSTE de inventario (es la casa: lo que falta se perdió
 *     o estaba mal contado).
 *   - Exhibición y aliado: lo que falta es LO QUE SE VENDIÓ. Se registra como
 *     una venta con el mismo motor del mostrador (sale de esa bodega), por
 *     defecto POR COBRAR, aunque al cerrar se puede dejar pagada o con abono.
 *     El aliado además lleva su descuento por escala. Lo que sobra entró sin
 *     registrarse y se trae de la principal.
 *     (Antes la exhibición solo trasladaba lo que faltaba a la principal, sin
 *     venta, y había que rehacerla en el mostrador: doble proceso, y un doble
 *     descuento si se hacía desde esa bodega.)
 */
@Injectable()
export class RetailStockCountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
    private readonly locations: RetailLocationsService,
    private readonly sales: RetailSalesService,
  ) {}

  private readonly txOptions = { timeout: 30_000 };

  // ─── Escalas estándar de la tienda ──────────────────────────────────────────

  async getAllySettings(ctx: TenantContext) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const row = await this.prisma.retailSettings.findUnique({
      where: {
        tenantId_branchId: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      },
      select: { allyTiers: true },
    });
    return { allyTiers: normalizeAllyTiers(row?.allyTiers) };
  }

  async updateAllySettings(ctx: TenantContext, dto: UpdateAllySettingsDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const allyTiers = normalizeAllyTiers(
      dto.allyTiers,
    ) as Prisma.InputJsonValue;
    const row = await this.prisma.retailSettings.upsert({
      where: {
        tenantId_branchId: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      },
      create: { tenantId: ctx.tenantId, branchId: ctx.branchId, allyTiers },
      update: { allyTiers },
      select: { allyTiers: true },
    });
    return { allyTiers: normalizeAllyTiers(row.allyTiers) };
  }

  // ─── Revistas ───────────────────────────────────────────────────────────────

  /**
   * Historial de una bodega, de la más reciente a la más vieja.
   *
   * Cada revista de aliado trae su liquidación con los ABONOS: cuándo pagó, por
   * dónde (efectivo, transferencia…), cuánto y la nota. Es la traza que pidió
   * Diego: "cuándo y por dónde me pagó esta bodega lo de cada revista". Los
   * abonos se registran en Por cobrar, como los de cualquier venta.
   */
  async listForLocation(ctx: TenantContext, locationId: string) {
    await this.findLocation(ctx, locationId);
    const counts = await this.prisma.retailStockCount.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId,
        status: { not: 'CANCELLED' },
      },
      orderBy: { startedAt: 'desc' },
      take: 30,
    });
    const saleIds = counts
      .map((count) => count.settlementSaleId)
      .filter((id): id is string => Boolean(id));
    const sales = saleIds.length
      ? await this.prisma.retailSale.findMany({
          where: { id: { in: saleIds }, tenantId: ctx.tenantId },
          select: {
            id: true,
            code: true,
            status: true,
            totalCOP: true,
            paidCOP: true,
            paymentStatus: true,
            payments: {
              where: { voidedAt: null },
              orderBy: { paidAt: 'asc' },
              select: {
                id: true,
                amountCOP: true,
                method: true,
                paidAt: true,
                note: true,
                userName: true,
              },
            },
          },
        })
      : [];
    const saleById = new Map(sales.map((sale) => [sale.id, sale]));

    // Lo que había, lo que faltó y lo que quedó, a PRECIO DE VENTA. Sale de los
    // renglones y no de los totales congelados: una revista cerrada con la regla
    // anterior no tiene valor vendido guardado, pero sus renglones sí dicen qué
    // faltó. Al cerrar, `expectedQty` queda refrescado contra el saldo real.
    const lines = counts.length
      ? await this.prisma.retailStockCountLine.findMany({
          where: { countId: { in: counts.map((count) => count.id) } },
          select: {
            countId: true,
            expectedQty: true,
            countedQty: true,
            unitPriceCOP: true,
          },
        })
      : [];
    const valuesByCount = new Map<
      string,
      {
        expectedValueCOP: number;
        remainingValueCOP: number;
        missingValueCOP: number;
        remainingUnits: number;
        missingUnits: number;
      }
    >();
    for (const line of lines) {
      const row = valuesByCount.get(line.countId) ?? {
        expectedValueCOP: 0,
        remainingValueCOP: 0,
        missingValueCOP: 0,
        remainingUnits: 0,
        missingUnits: 0,
      };
      const counted = effectiveCount(line);
      row.expectedValueCOP += line.expectedQty * line.unitPriceCOP;
      row.remainingValueCOP += counted * line.unitPriceCOP;
      row.remainingUnits += counted;
      if (counted < line.expectedQty) {
        row.missingUnits += line.expectedQty - counted;
        row.missingValueCOP += (line.expectedQty - counted) * line.unitPriceCOP;
      }
      valuesByCount.set(line.countId, row);
    }

    return counts.map((count) => {
      const sale = count.settlementSaleId
        ? saleById.get(count.settlementSaleId)
        : undefined;
      return {
        ...count,
        ...(valuesByCount.get(count.id) ?? {
          expectedValueCOP: 0,
          remainingValueCOP: 0,
          missingValueCOP: 0,
          remainingUnits: 0,
          missingUnits: 0,
        }),
        settlement: sale
          ? {
              saleId: sale.id,
              code: sale.code,
              voided: sale.status === 'VOIDED',
              totalCOP: sale.totalCOP,
              paidCOP: sale.paidCOP,
              balanceCOP: Math.max(0, sale.totalCOP - sale.paidCOP),
              paymentStatus: sale.paymentStatus,
              payments: sale.payments,
            }
          : null,
      };
    });
  }

  /**
   * Abre una revista, o devuelve la que ya estaba abierta: dos revistas a la
   * vez de la misma bodega se pisarían al cerrar.
   */
  async open(ctx: TenantContext, locationId: string) {
    const location = await this.findLocation(ctx, locationId);
    const draft = await this.prisma.retailStockCount.findFirst({
      where: { locationId, status: 'DRAFT' },
      select: { id: true },
    });
    if (draft) return this.get(ctx, draft.id);

    const balances = await this.prisma.retailStockBalance.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId: location.id,
        qty: { not: 0 },
        product: { deletedAt: null, trackStock: true },
      },
      include: {
        product: {
          select: {
            name: true,
            priceCOP: true,
            costCOP: true,
            avgCostCOP: true,
            category: { select: { name: true } },
          },
        },
        variant: { select: { label: true } },
      },
    });

    const count = await this.prisma.retailStockCount.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId: location.id,
        userId: ctx.userId,
        userName: ctx.name,
        lines: {
          create: balances.map((balance) => ({
            productId: balance.productId,
            variantId: balance.variantId,
            name: balance.product.name,
            variantLabel: balance.variant?.label ?? null,
            categoryName: balance.product.category?.name ?? null,
            expectedQty: balance.qty,
            unitPriceCOP: balance.product.priceCOP,
            unitCostCOP: balance.product.avgCostCOP ?? balance.product.costCOP,
          })),
        },
      },
      select: { id: true },
    });
    return this.get(ctx, count.id);
  }

  /** La revista con sus renglones y el resumen de lo que pasaría al cerrarla. */
  async get(ctx: TenantContext, countId: string) {
    const count = await this.findCount(ctx, countId);
    const mode = modeOf(count.location);
    const tiers =
      mode === 'ALLY' ? await this.tiersFor(ctx, count.location.allyTiers) : [];
    return {
      ...count,
      location: {
        id: count.location.id,
        name: count.location.name,
        holderName: count.location.holderName,
        kind: count.location.kind,
        isDefault: count.location.isDefault,
      },
      mode,
      allyTiers: tiers,
      // En una revista cerrada el resumen es el congelado; en una abierta es
      // la vista previa con lo contado hasta ahora.
      summary:
        count.status === 'CLOSED'
          ? {
              expectedUnits: count.expectedUnits,
              countedUnits: count.countedUnits,
              missingUnits: count.soldUnits,
              extraUnits: 0,
              soldUnits: count.soldUnits,
              soldValueCOP: count.soldValueCOP,
              discountPct: count.discountPct ?? 0,
              discountCOP: count.discountCOP,
              netCOP: count.netCOP,
            }
          : summarize(count.lines, mode, tiers),
    };
  }

  /** Guarda lo contado. Se llama seguido mientras se cuenta: es el autoguardado. */
  async update(
    ctx: TenantContext,
    countId: string,
    dto: UpdateRetailStockCountDto,
  ) {
    const count = await this.findCount(ctx, countId);
    if (count.status !== 'DRAFT') {
      throw new BadRequestException('Esta revista ya no está abierta');
    }
    const lineIds = new Set(count.lines.map((line) => line.id));
    for (const line of dto.lines ?? []) {
      if (!lineIds.has(line.lineId)) {
        throw new BadRequestException('Ese renglón no es de esta revista');
      }
    }
    await this.prisma.$transaction(async (tx) => {
      for (const line of dto.lines ?? []) {
        await tx.retailStockCountLine.update({
          where: { id: line.lineId },
          data: { countedQty: line.countedQty },
        });
      }
      if (dto.note !== undefined) {
        await tx.retailStockCount.update({
          where: { id: countId },
          data: { note: dto.note?.trim() || null },
        });
      }
    });
    return this.get(ctx, countId);
  }

  async cancel(ctx: TenantContext, countId: string) {
    const count = await this.findCount(ctx, countId);
    if (count.status !== 'DRAFT') {
      throw new BadRequestException('Solo se descarta una revista abierta');
    }
    await this.prisma.retailStockCount.update({
      where: { id: countId },
      data: { status: 'CANCELLED', closedAt: new Date() },
    });
    return { ok: true };
  }

  /**
   * Cierra la revista y aplica la diferencia.
   *
   * Lo esperado se REFRESCA aquí contra el saldo de este momento, no se usa el
   * de cuando se abrió: entre abrir y cerrar pudo haber ventas o traslados, y
   * lo que se contó en el estante se compara contra lo que hay ahora.
   */
  async close(
    ctx: TenantContext,
    countId: string,
    opts: CloseRetailStockCountDto = {},
  ) {
    const count = await this.findCount(ctx, countId);
    if (count.status !== 'DRAFT') {
      throw new BadRequestException('Esta revista ya está cerrada');
    }
    const location = count.location;
    const mode = modeOf(location);
    const tiers =
      mode === 'ALLY' ? await this.tiersFor(ctx, location.allyTiers) : [];

    const balances = await this.prisma.retailStockBalance.findMany({
      where: { locationId: location.id },
      select: { productId: true, variantId: true, qty: true },
    });
    const currentOf = (line: RetailStockCountLine) =>
      balances.find(
        (row) =>
          row.productId === line.productId &&
          (row.variantId ?? null) === (line.variantId ?? null),
      )?.qty ?? 0;
    const lines = count.lines.map((line) => ({
      ...line,
      expectedQty: currentOf(line),
    }));
    const summary = summarize(lines, mode, tiers);
    const frozen = {
      expectedUnits: summary.expectedUnits,
      countedUnits: summary.countedUnits,
      soldUnits: summary.soldUnits,
      soldValueCOP: summary.soldValueCOP,
      discountPct: mode === 'ALLY' ? summary.discountPct : null,
      discountCOP: summary.discountCOP,
      netCOP: summary.netCOP,
    };

    // ALIADO o EXHIBICIÓN: primero la venta, con el motor de ventas de siempre
    // (stock, kardex, lotes, Por cobrar, finanzas). Va en su propia transacción
    // porque `createSale` abre la suya; por eso se guarda enseguida en la
    // revista, y si el resto del cierre falla, reintentar no la duplica.
    let settlementSaleId = count.settlementSaleId;
    const sold = lines.filter(
      (line) => effectiveCount(line) < line.expectedQty,
    );
    if (mode !== 'PRINCIPAL' && sold.length > 0 && !settlementSaleId) {
      const customerId = opts.customerId
        ? await this.useCustomer(ctx, location, opts.customerId)
        : await this.ensureAllyCustomer(ctx, location);
      // Por defecto POR COBRAR, como en el mostrador cuando se fía. Pagada de
      // una vez, o con un abono, solo si quien cierra lo elige.
      const paid = opts.paymentStatus === 'PAID';
      const sale = await this.sales.createSale(ctx, {
        items: sold.map((line) => ({
          productId: line.productId,
          variantId: line.variantId ?? undefined,
          quantity: line.expectedQty - effectiveCount(line),
          unitPriceCOP: line.unitPriceCOP,
          locationId: location.id,
        })),
        customerId,
        saleType: 'RETAIL',
        deliveryStatus: 'DELIVERED',
        paymentStatus: paid ? 'PAID' : 'PENDING',
        ...(paid ? { paymentMethod: opts.paymentMethod ?? 'CASH' } : {}),
        ...(!paid && opts.depositCOP
          ? {
              depositCOP: opts.depositCOP,
              depositMethod: opts.depositMethod ?? 'CASH',
            }
          : {}),
        discountCOP: summary.discountCOP,
        note:
          `${mode === 'ALLY' ? 'Liquidación' : 'Venta'} de revista · ${location.name}` +
          (summary.discountPct
            ? ` · descuento aliado ${summary.discountPct}%`
            : ''),
      });
      settlementSaleId = sale.id;
      await this.prisma.retailStockCount.update({
        where: { id: count.id },
        data: { settlementSaleId, ...frozen },
      });
    }

    await this.prisma.$transaction(async (tx) => {
      const reason = `Revista · ${location.name}`;
      if (mode === 'PRINCIPAL') {
        for (const line of lines) {
          const diff = effectiveCount(line) - line.expectedQty;
          if (diff !== 0)
            await this.adjust(tx, ctx, location.id, line, diff, reason);
        }
      } else {
        const principal = await ensureDefaultLocation(tx, ctx);
        // Lo que falta ya salió en la venta de arriba; aquí solo lo que SOBRA
        // (entró sin registrarse): se trae de la principal.
        const items = lines
          .filter((line) => effectiveCount(line) > line.expectedQty)
          .map((line) => ({
            productId: line.productId,
            variantId: line.variantId ?? undefined,
            quantity: effectiveCount(line),
          }));
        if (items.length > 0) {
          await this.locations.applyCount(tx, ctx, {
            locationId: location.id,
            principalId: principal.id,
            items,
            reason,
          });
        }
      }

      for (const line of lines) {
        await tx.retailStockCountLine.update({
          where: { id: line.id },
          data: { expectedQty: line.expectedQty },
        });
      }
      await tx.retailStockCount.update({
        where: { id: count.id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          settlementSaleId,
          ...frozen,
        },
      });
    }, this.txOptions);

    return this.get(ctx, count.id);
  }

  // ─── Entregas por categoría ─────────────────────────────────────────────────

  /**
   * Qué se le ha llevado a una bodega, agrupado por categoría. Sale de los
   * traslados: la fila de ENTRADA al destino (positiva) es lo entregado, y la
   * de salida de ese mismo sitio (negativa) es lo que se devolvió.
   */
  async deliveredReport(
    ctx: TenantContext,
    locationId: string,
    range: { from?: string; to?: string },
  ) {
    await this.findLocation(ctx, locationId);
    const movements = await this.prisma.retailStockMovement.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        locationId,
        // Traslados (lo entregado y lo devuelto) y también lo VENDIDO desde esta
        // bodega: la revista ya no lo manda de vuelta a la principal, sale en una
        // venta, y sin contarlo aquí "entregadas − devueltas" no cuadra con lo
        // que quedó.
        type: { in: ['TRANSFER', 'SALE', 'RETURN'] },
        ...(range.from || range.to
          ? {
              createdAt: {
                ...(range.from ? { gte: new Date(range.from) } : {}),
                ...(range.to ? { lte: new Date(range.to) } : {}),
              },
            }
          : {}),
      },
      include: {
        product: {
          select: {
            name: true,
            priceCOP: true,
            costCOP: true,
            avgCostCOP: true,
            category: { select: { name: true } },
          },
        },
        variant: { select: { label: true } },
      },
      orderBy: { createdAt: 'asc' },
    });

    type Row = {
      productId: string;
      name: string;
      variantLabel: string | null;
      delivered: number;
      returned: number;
      sold: number;
    };
    const categories = new Map<
      string,
      {
        categoryName: string;
        delivered: number;
        returned: number;
        sold: number;
        valueAtPriceCOP: number;
        valueAtCostCOP: number;
        products: Map<string, Row>;
      }
    >();
    for (const movement of movements) {
      const categoryName = movement.product.category?.name ?? 'Sin categoría';
      const bucket = categories.get(categoryName) ?? {
        categoryName,
        delivered: 0,
        returned: 0,
        sold: 0,
        valueAtPriceCOP: 0,
        valueAtCostCOP: 0,
        products: new Map<string, Row>(),
      };
      const rowKey = `${movement.productId}|${movement.variantId ?? ''}`;
      const row = bucket.products.get(rowKey) ?? {
        productId: movement.productId,
        name: movement.product.name,
        variantLabel: movement.variant?.label ?? null,
        delivered: 0,
        returned: 0,
        sold: 0,
      };
      const units = Math.abs(movement.quantity);
      // Una venta saca (cantidad negativa) y su anulación devuelve (positiva):
      // lo vendido es el neto. No es una entrega ni una devolución a la principal.
      if (movement.type === 'SALE' || movement.type === 'RETURN') {
        const net = movement.type === 'SALE' ? units : -units;
        row.sold += net;
        bucket.sold += net;
        bucket.products.set(rowKey, row);
        categories.set(categoryName, bucket);
        continue;
      }
      const sign = movement.quantity > 0 ? 1 : -1;
      if (sign > 0) {
        row.delivered += units;
        bucket.delivered += units;
      } else {
        row.returned += units;
        bucket.returned += units;
      }
      // Valor de lo entregado neto de lo devuelto.
      bucket.valueAtPriceCOP += sign * units * movement.product.priceCOP;
      bucket.valueAtCostCOP +=
        sign *
        units *
        (movement.unitCostCOP ??
          movement.product.avgCostCOP ??
          movement.product.costCOP);
      bucket.products.set(rowKey, row);
      categories.set(categoryName, bucket);
    }

    const list = [...categories.values()]
      .map((bucket) => ({
        ...bucket,
        products: [...bucket.products.values()].sort(
          (a, b) => b.delivered - a.delivered,
        ),
      }))
      .sort((a, b) => b.delivered - a.delivered);
    return {
      delivered: list.reduce((sum, bucket) => sum + bucket.delivered, 0),
      returned: list.reduce((sum, bucket) => sum + bucket.returned, 0),
      sold: list.reduce((sum, bucket) => sum + bucket.sold, 0),
      valueAtPriceCOP: list.reduce((sum, row) => sum + row.valueAtPriceCOP, 0),
      valueAtCostCOP: list.reduce((sum, row) => sum + row.valueAtCostCOP, 0),
      categories: list,
    };
  }

  // ─── Interno ────────────────────────────────────────────────────────────────

  /** Ajuste de la principal: mueve total, opción, saldo y kardex. */
  private async adjust(
    tx: Tx,
    ctx: TenantContext,
    locationId: string,
    line: { productId: string; variantId: string | null },
    diff: number,
    reason: string,
  ) {
    const product = await tx.retailProduct.findUniqueOrThrow({
      where: { id: line.productId },
      select: { stock: true, costCOP: true, avgCostCOP: true },
    });
    const stockAfter = product.stock + diff;
    await tx.retailProduct.update({
      where: { id: line.productId },
      data: { stock: stockAfter },
    });
    if (line.variantId) {
      await tx.retailProductVariant.update({
        where: { id: line.variantId },
        data: { stock: { increment: diff } },
      });
    }
    await applySignedDelta(tx, ctx, {
      productId: line.productId,
      variantId: line.variantId,
      delta: diff,
      locationId,
    });
    await tx.retailStockMovement.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: line.productId,
        variantId: line.variantId,
        type: 'ADJUSTMENT',
        quantity: diff,
        stockAfter,
        locationId,
        unitCostCOP: product.avgCostCOP ?? product.costCOP,
        reason,
        userId: ctx.userId,
      },
    });
  }

  /**
   * La ficha de cliente del aliado, creándola la primera vez. Es lo que hace
   * que su liquidación aparezca en Por cobrar con nombre y teléfono.
   */
  private async ensureAllyCustomer(
    ctx: TenantContext,
    location: {
      id: string;
      name: string;
      holderName: string | null;
      phone: string | null;
      customerId: string | null;
    },
  ): Promise<string> {
    if (location.customerId) {
      const existing = await this.prisma.retailCustomer.findFirst({
        where: { id: location.customerId, deletedAt: null },
        select: { id: true },
      });
      if (existing) return existing.id;
    }
    const phone = location.phone?.replace(/\s/g, '') || null;
    const byPhone = phone
      ? await this.prisma.retailCustomer.findFirst({
          where: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            phone,
            deletedAt: null,
          },
          select: { id: true },
        })
      : null;
    const customer =
      byPhone ??
      (await this.prisma.retailCustomer.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          name: location.holderName ?? location.name,
          phone,
          notes: `Aliado · ${location.name}`,
        },
        select: { id: true },
      }));
    await this.prisma.retailStockLocation.update({
      where: { id: location.id },
      data: { customerId: customer.id },
    });
    return customer.id;
  }

  /** Un cliente elegido a mano para la venta; se recuerda en la bodega si no tenía. */
  private async useCustomer(
    ctx: TenantContext,
    location: { id: string; customerId: string | null },
    customerId: string,
  ): Promise<string> {
    const customer = await this.prisma.retailCustomer.findFirst({
      where: {
        id: customerId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (!customer) throw new BadRequestException('Ese cliente no existe');
    if (!location.customerId) {
      await this.prisma.retailStockLocation.update({
        where: { id: location.id },
        data: { customerId: customer.id },
      });
    }
    return customer.id;
  }

  /**
   * Asocia a una revista cerrada la venta que se hizo por separado en el
   * mostrador, el doble proceso de antes.
   *
   * SOLO REVISTAS SIN VENTA. Una revista que ya creó la suya no se toca. Las que
   * quedan sin venta son las de exhibición cerradas con la regla anterior, que
   * movieron lo que faltaba a la principal.
   *
   * EL DOBLE DESCUENTO. Si la venta se hizo escogiendo la bodega, esas unidades
   * salieron DOS veces de ella (la revista las movió a la principal y la venta
   * las descontó otra vez) y la principal quedó con unidades que no existen.
   * Con `fixInventory` se devuelven de la principal a la bodega, que es un
   * traslado normal y deja rastro en el kardex. Una venta hecha desde la
   * principal ya cuadra: solo se asocia.
   */
  async linkSale(
    ctx: TenantContext,
    countId: string,
    dto: LinkRetailStockCountSaleDto,
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const count = await this.findCount(ctx, countId);
    if (count.status !== 'CLOSED') {
      throw new BadRequestException('Solo se asocia a una revista cerrada');
    }
    if (count.settlementSaleId) {
      throw new BadRequestException('Esta revista ya tiene su venta');
    }
    if (modeOf(count.location) === 'PRINCIPAL') {
      throw new BadRequestException(
        'La bodega principal no genera ventas: su diferencia es un ajuste',
      );
    }
    const sale = await this.prisma.retailSale.findFirst({
      where: {
        id: dto.saleId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      include: { items: true },
    });
    if (!sale) throw new NotFoundException('Venta no encontrada');
    if (sale.status === 'VOIDED') {
      throw new BadRequestException('Esa venta está anulada');
    }
    const taken = await this.prisma.retailStockCount.findFirst({
      where: { settlementSaleId: sale.id },
      select: { id: true },
    });
    if (taken) {
      throw new BadRequestException('Esa venta ya está asociada a una revista');
    }

    // Lo que la revista sacó de la bodega por línea, contra lo que esa venta
    // descontó de la misma bodega: el mínimo de las dos es lo que se contó doble.
    const principal = await this.prisma.retailStockLocation.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        isDefault: true,
      },
      select: { id: true },
    });
    const corrections: {
      productId: string;
      variantId: string | null;
      name: string;
      variantLabel: string | null;
      quantity: number;
    }[] = [];
    for (const line of count.lines) {
      const missing = line.expectedQty - effectiveCount(line);
      if (missing <= 0) continue;
      const soldFromHere = sale.items
        .filter(
          (item) =>
            item.productId === line.productId &&
            (item.variantId ?? null) === (line.variantId ?? null) &&
            item.locationId === count.locationId,
        )
        .reduce((sum, item) => sum + item.quantity, 0);
      const quantity = Math.min(missing, soldFromHere);
      if (quantity > 0) {
        corrections.push({
          productId: line.productId,
          variantId: line.variantId ?? null,
          name: line.name,
          variantLabel: line.variantLabel ?? null,
          quantity,
        });
      }
    }

    const result = {
      sale: { id: sale.id, code: sale.code, totalCOP: sale.totalCOP },
      corrections,
      correctedUnits: corrections.reduce((sum, row) => sum + row.quantity, 0),
    };
    if (dto.dryRun) return { ...result, linked: false };

    if (dto.fixInventory && corrections.length > 0 && principal) {
      await this.locations.transfer(ctx, {
        fromLocationId: principal.id,
        toLocationId: count.locationId,
        items: corrections.map((row) => ({
          productId: row.productId,
          variantId: row.variantId ?? undefined,
          quantity: row.quantity,
        })),
        note: `Corrección: ${sale.code} ya descontó lo de la revista`,
      });
    }
    await this.prisma.retailStockCount.update({
      where: { id: count.id },
      data: { settlementSaleId: sale.id },
    });
    return { ...result, linked: true, fixed: Boolean(dto.fixInventory) };
  }

  /** Las del aliado si tiene propias; si no, las de la tienda. */
  private async tiersFor(
    ctx: TenantContext,
    own: Prisma.JsonValue | null,
  ): Promise<AllyTier[]> {
    if (own !== null) return normalizeAllyTiers(own);
    return (await this.getAllySettings(ctx)).allyTiers;
  }

  private async findLocation(ctx: TenantContext, locationId: string) {
    const location = await this.prisma.retailStockLocation.findFirst({
      where: { id: locationId, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!location) throw new NotFoundException('Bodega no encontrada');
    return location;
  }

  private async findCount(ctx: TenantContext, countId: string) {
    const count = await this.prisma.retailStockCount.findFirst({
      where: { id: countId, tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: {
        location: true,
        lines: { orderBy: [{ categoryName: 'asc' }, { name: 'asc' }] },
      },
    });
    if (!count) throw new NotFoundException('Revista no encontrada');
    return count;
  }
}

function modeOf(location: { isDefault: boolean; kind: string }): CountMode {
  if (location.isDefault) return 'PRINCIPAL';
  return location.kind === 'ALLY' ? 'ALLY' : 'EXHIBITION';
}

/** Un renglón sin tocar cuenta como "está igual": es lo que hace rápida la revista. */
function effectiveCount(line: {
  countedQty: number | null;
  expectedQty: number;
}) {
  return line.countedQty ?? line.expectedQty;
}

/** Lo que pasaría al cerrar con lo contado hasta ahora. */
export function summarize(
  lines: Array<{
    countedQty: number | null;
    expectedQty: number;
    unitPriceCOP: number;
  }>,
  mode: CountMode,
  tiers: AllyTier[],
) {
  let expectedUnits = 0;
  let countedUnits = 0;
  let missingUnits = 0;
  let extraUnits = 0;
  let missingValueCOP = 0;
  for (const line of lines) {
    const counted = effectiveCount(line);
    expectedUnits += line.expectedQty;
    countedUnits += counted;
    const diff = counted - line.expectedQty;
    if (diff < 0) {
      missingUnits += -diff;
      missingValueCOP += -diff * line.unitPriceCOP;
    } else {
      extraUnits += diff;
    }
  }
  // Lo que falta se vendió en toda bodega que no es la principal. El descuento
  // por escala es solo del aliado.
  const sells = mode !== 'PRINCIPAL';
  const soldValueCOP = sells ? missingValueCOP : 0;
  const discountPct =
    mode === 'ALLY' ? allyDiscountPct(tiers, soldValueCOP) : 0;
  const discountCOP = Math.round((soldValueCOP * discountPct) / 100);
  return {
    expectedUnits,
    countedUnits,
    missingUnits,
    extraUnits,
    soldUnits: sells ? missingUnits : 0,
    soldValueCOP,
    discountPct,
    discountCOP,
    netCOP: soldValueCOP - discountCOP,
  };
}
