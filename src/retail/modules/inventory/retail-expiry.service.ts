import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { calendarDayCO, diffCalendarDaysCO } from '../../../common/date.util';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  applyBalanceDelta,
  resolveLocation,
} from '../../shared/retail-stock-locations';
import { lotDate, lotDay, receiveLots } from '../../shared/retail-stock-lots';
import {
  AssignRetailStockLotDto,
  CreateRetailStockLotDto,
  UpdateRetailSettingsDto,
  UpdateRetailStockLotDto,
} from './dto/retail-inventory.dto';

/** Lo que vale cuando la tienda nunca guardó ajustes. Espeja el default de la tabla. */
const DEFAULT_EXPIRY_ALERT_DAYS = 60;

export type ExpiryStatus = 'EXPIRED' | 'SOON' | 'OK';

/**
 * [VERTICAL_RETAIL] Vencimientos: qué vence pronto, y fechar lo que ya estaba.
 *
 * SIN JOBS. Las alertas se calculan al abrir la pantalla, no las manda nada
 * programado: así lo decidió Diego hasta medir el costo de un scheduler (ver
 * docs/PLAN_RETAIL_AJUSTES_OCTUBRE_2026.md §7). Por eso este servicio solo lee
 * y corrige; el movimiento de los lotes vive en `retail-stock-lots.ts`.
 */
@Injectable()
export class RetailExpiryService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  // ─── Ajustes ────────────────────────────────────────────────────────────────

  async getSettings(ctx: TenantContext) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const row = await this.prisma.retailSettings.findUnique({
      where: {
        tenantId_branchId: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      },
    });
    return {
      expiryAlertDays: row?.expiryAlertDays ?? DEFAULT_EXPIRY_ALERT_DAYS,
    };
  }

  async updateSettings(ctx: TenantContext, dto: UpdateRetailSettingsDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const row = await this.prisma.retailSettings.upsert({
      where: {
        tenantId_branchId: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      },
      create: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        expiryAlertDays: dto.expiryAlertDays ?? DEFAULT_EXPIRY_ALERT_DAYS,
      },
      update: { expiryAlertDays: dto.expiryAlertDays },
    });
    return { expiryAlertDays: row.expiryAlertDays };
  }

  // ─── Alertas ────────────────────────────────────────────────────────────────

  /**
   * Los lotes con unidades, del que vence antes al de después.
   *
   * `alertsOnly` deja solo los vencidos y los que entraron en su ventana de
   * aviso. La ventana es por producto: una crema puede avisar a 90 días y un
   * splash a 30, y lo que no trae la suya usa el estándar de la tienda.
   */
  async listLots(ctx: TenantContext, alertsOnly: boolean) {
    const { expiryAlertDays: defaultDays } = await this.getSettings(ctx);
    const lots = await this.prisma.retailStockLot.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        qty: { gt: 0 },
        // Un producto que dejó de vencer o se borró no tiene por qué seguir
        // avisando; sus lotes se conservan por si se vuelve a encender.
        product: { tracksExpiry: true, deletedAt: null },
      },
      orderBy: [{ expiresOn: 'asc' }, { createdAt: 'asc' }],
      include: {
        product: {
          select: {
            name: true,
            expiryAlertDays: true,
            priceCOP: true,
            costCOP: true,
            avgCostCOP: true,
          },
        },
        variant: { select: { label: true } },
        location: { select: { name: true } },
      },
      take: 1000,
    });

    const today = new Date();
    const rows = lots.map((lot) => {
      const day = lotDay(lot.expiresOn);
      // El día del lote se ancla a mediodía para que la diferencia sea en días
      // calendario colombianos y no dependa de la hora de la consulta.
      const daysLeft = diffCalendarDaysCO(today, `${day}T12:00:00.000-05:00`);
      const alertDays = lot.product.expiryAlertDays ?? defaultDays;
      const status: ExpiryStatus =
        daysLeft < 0 ? 'EXPIRED' : daysLeft <= alertDays ? 'SOON' : 'OK';
      const unitCost = lot.product.avgCostCOP ?? lot.product.costCOP;
      return {
        lotId: lot.id,
        productId: lot.productId,
        productName: lot.product.name,
        variantId: lot.variantId,
        variantLabel: lot.variant?.label ?? null,
        locationId: lot.locationId,
        locationName: lot.location.name,
        expiresOn: day,
        lotCode: lot.lotCode,
        qty: lot.qty,
        daysLeft,
        alertDays,
        status,
        // Lo que está en juego si se vence: a costo (lo que se perdería) y a
        // precio (lo que se dejaría de vender).
        valueAtCostCOP: lot.qty * unitCost,
        valueAtPriceCOP: lot.qty * lot.product.priceCOP,
      };
    });

    const visible = alertsOnly
      ? rows.filter((row) => row.status !== 'OK')
      : rows;
    const sum = (status: ExpiryStatus) =>
      rows.filter((row) => row.status === status);
    return {
      today: calendarDayCO(today),
      defaultAlertDays: defaultDays,
      expiredCount: sum('EXPIRED').length,
      soonCount: sum('SOON').length,
      expiredValueAtCostCOP: sum('EXPIRED').reduce(
        (total, row) => total + row.valueAtCostCOP,
        0,
      ),
      soonValueAtCostCOP: sum('SOON').reduce(
        (total, row) => total + row.valueAtCostCOP,
        0,
      ),
      lots: visible,
    };
  }

  // ─── Lotes de un producto ───────────────────────────────────────────────────

  /**
   * Lo fechado y lo "sin fecha" de un producto, por bodega y aroma.
   *
   * "Sin fecha" es el saldo menos lo fechado. Se calcula en vez de guardarse
   * para que nunca pueda descuadrar: si el saldo cambia, el pendiente cambia
   * con él.
   */
  async productLots(ctx: TenantContext, productId: string) {
    await this.assertProduct(ctx, productId);
    const [balances, lots] = await Promise.all([
      this.prisma.retailStockBalance.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId, productId },
        include: {
          location: { select: { name: true, isDefault: true } },
          variant: { select: { label: true } },
        },
      }),
      this.prisma.retailStockLot.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId,
          qty: { gt: 0 },
        },
        orderBy: { expiresOn: 'asc' },
      }),
    ]);

    return balances
      .filter((balance) => balance.qty !== 0)
      .map((balance) => {
        const own = lots.filter(
          (lot) =>
            lot.locationId === balance.locationId &&
            (lot.variantId ?? null) === (balance.variantId ?? null),
        );
        const dated = own.reduce((total, lot) => total + lot.qty, 0);
        return {
          locationId: balance.locationId,
          locationName: balance.location.name,
          // El mostrador muestra por defecto las fechas de la principal: es de
          // donde sale casi toda venta.
          isDefaultLocation: balance.location.isDefault,
          variantId: balance.variantId,
          variantLabel: balance.variant?.label ?? null,
          qty: balance.qty,
          undatedQty: Math.max(0, balance.qty - dated),
          lots: own.map((lot) => ({
            lotId: lot.id,
            expiresOn: lotDay(lot.expiresOn),
            lotCode: lot.lotCode,
            qty: lot.qty,
          })),
        };
      });
  }

  /**
   * Ponerle fecha a unidades que ya estaban "sin fecha". No mueve stock ni
   * kardex: la mercancía ya estaba, solo se dice cuándo vence.
   */
  async createLot(ctx: TenantContext, dto: CreateRetailStockLotDto) {
    const product = await this.assertProduct(ctx, dto.productId);
    if (!product.tracksExpiry) {
      throw new BadRequestException(
        `"${product.name}" no está marcado como producto que vence`,
      );
    }

    return this.prisma.$transaction(async (tx) => {
      const locationId = await resolveLocation(tx, ctx, dto.locationId);
      const variantId = dto.variantId ?? null;
      const [balance, dated] = await Promise.all([
        tx.retailStockBalance.findFirst({
          where: { locationId, productId: dto.productId, variantId },
          select: { qty: true },
        }),
        tx.retailStockLot.aggregate({
          where: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            locationId,
            productId: dto.productId,
            variantId,
            qty: { gt: 0 },
          },
          _sum: { qty: true },
        }),
      ]);
      const undated = (balance?.qty ?? 0) - (dated._sum.qty ?? 0);
      // Aquí SÍ se valida, a diferencia de las ventas: nadie está esperando en
      // el mostrador, y fechar más de lo que hay inventaría unidades.
      if (dto.qty > undated) {
        throw new BadRequestException(
          undated <= 0
            ? 'Todo lo que hay en ese sitio ya tiene fecha'
            : `Solo hay ${undated} sin fecha en ese sitio`,
        );
      }
      // Sin fecha y sin sabor no hay nada que hacer; sin fecha pero con sabor,
      // es solo asignarlo y las unidades siguen "sin fecha".
      if (!dto.expiresOn && !dto.assignVariantId) {
        throw new BadRequestException('Falta la fecha de vencimiento');
      }
      const datedEntry = dto.expiresOn
        ? {
            kind: 'dated' as const,
            expiresOn: dto.expiresOn,
            lotCode: dto.lotCode,
          }
        : undefined;

      if (!dto.assignVariantId && datedEntry) {
        await receiveLots(
          tx,
          ctx,
          { locationId, productId: dto.productId, variantId },
          dto.qty,
          datedEntry,
        );
        return { ok: true };
      }

      // Asignar sabor y fecha en un paso: las unidades salen de "sin opción" y
      // entran al sabor elegido ya fechadas. Es un reparto, no un movimiento:
      // el total del producto no cambia y no deja kardex, igual que repartir
      // desde el catálogo.
      if (variantId) {
        throw new BadRequestException(
          'Solo se le asigna opción a unidades que todavía no la tienen',
        );
      }
      const variant = await tx.retailProductVariant.findFirst({
        where: { id: dto.assignVariantId, productId: dto.productId },
        select: { id: true },
      });
      if (!variant) {
        throw new BadRequestException('Esa opción no es de este producto');
      }
      await tx.retailProductVariant.update({
        where: { id: variant.id },
        data: { stock: { increment: dto.qty } },
      });
      // Salen de lo "sin fecha" a propósito: las unidades fechadas de "sin
      // opción" no se tocan, porque no son las que se están asignando.
      await applyBalanceDelta(
        tx,
        ctx,
        { locationId, productId: dto.productId, variantId: null },
        -dto.qty,
        { kind: 'undated' },
      );
      await applyBalanceDelta(
        tx,
        ctx,
        { locationId, productId: dto.productId, variantId: variant.id },
        dto.qty,
        datedEntry,
      );
      return { ok: true };
    });
  }

  /**
   * Le asigna opción (sabor) a unidades de un lote que entró sin ella,
   * conservando su fecha. Mismo reparto que `createLot` con `assignVariantId`,
   * pero desde unidades que ya estaban fechadas.
   */
  async assignLot(
    ctx: TenantContext,
    id: string,
    dto: AssignRetailStockLotDto,
  ) {
    await this.assertLot(ctx, id);
    return this.prisma.$transaction(async (tx) => {
      const lot = await tx.retailStockLot.findUniqueOrThrow({ where: { id } });
      if (lot.variantId) {
        throw new BadRequestException('Este lote ya tiene opción');
      }
      if (dto.qty > lot.qty) {
        throw new BadRequestException(`El lote solo tiene ${lot.qty}`);
      }
      const variant = await tx.retailProductVariant.findFirst({
        where: { id: dto.variantId, productId: lot.productId },
        select: { id: true },
      });
      if (!variant) {
        throw new BadRequestException('Esa opción no es de este producto');
      }

      // Las unidades se van del lote del todo —no se consumieron—, así que
      // también bajan de lo recibido: si no, una anulación creería que hay
      // hueco para devolverlas aquí.
      await tx.retailStockLot.update({
        where: { id },
        data: {
          qty: { decrement: dto.qty },
          receivedQty: { decrement: dto.qty },
        },
      });
      await tx.retailProductVariant.update({
        where: { id: variant.id },
        data: { stock: { increment: dto.qty } },
      });
      const key = { locationId: lot.locationId, productId: lot.productId };
      // El saldo de "sin opción" baja sin consumir otros lotes: las unidades
      // que salen son estas, y ya se descontaron arriba.
      await applyBalanceDelta(tx, ctx, { ...key, variantId: null }, -dto.qty, {
        kind: 'undated',
      });
      await applyBalanceDelta(
        tx,
        ctx,
        { ...key, variantId: variant.id },
        dto.qty,
        {
          kind: 'dated',
          expiresOn: lotDay(lot.expiresOn),
          lotCode: lot.lotCode,
        },
      );
      return { ok: true };
    });
  }

  /** Corrige la fecha o el código de un lote mal digitado. */
  async updateLot(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailStockLotDto,
  ) {
    await this.assertLot(ctx, id);
    const lot = await this.prisma.retailStockLot.update({
      where: { id },
      data: {
        ...(dto.expiresOn ? { expiresOn: lotDate(dto.expiresOn) } : {}),
        ...(dto.lotCode !== undefined
          ? { lotCode: dto.lotCode?.trim() || null }
          : {}),
      },
    });
    return {
      lotId: lot.id,
      expiresOn: lotDay(lot.expiresOn),
      lotCode: lot.lotCode,
    };
  }

  /**
   * Quita la fecha: las unidades vuelven a "sin fecha". No mueve stock: la
   * mercancía sigue ahí, solo deja de tener un vencimiento anotado.
   */
  async deleteLot(ctx: TenantContext, id: string) {
    await this.assertLot(ctx, id);
    await this.prisma.retailStockLot.delete({ where: { id } });
    return { ok: true };
  }

  // ─── Interno ────────────────────────────────────────────────────────────────

  private async assertProduct(ctx: TenantContext, productId: string) {
    const product = await this.prisma.retailProduct.findFirst({
      where: {
        id: productId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      select: { id: true, name: true, tracksExpiry: true },
    });
    if (!product) throw new NotFoundException('Producto no encontrado');
    return product;
  }

  private async assertLot(ctx: TenantContext, id: string) {
    const lot = await this.prisma.retailStockLot.findFirst({
      where: { id, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!lot) throw new NotFoundException('Lote no encontrado');
  }
}
