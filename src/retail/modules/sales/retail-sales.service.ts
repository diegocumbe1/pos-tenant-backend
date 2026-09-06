import { BadRequestException, Injectable } from '@nestjs/common';
import {
  Prisma,
  RetailDeliveryStatus,
  RetailPaymentMethod,
  RetailPaymentStatus,
  RetailSaleEventKind,
  RetailSaleType,
} from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  costingCostCOP,
  weightedAverageCost,
} from '../../shared/retail-costing';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  CO_UTC_OFFSET,
  calendarDayCO,
  clockTimeCO,
  formatCOP,
} from '../../../common/date.util';
import {
  CreateRetailSaleDto,
  CreateRetailSaleNoteDto,
  CreateRetailSalePaymentDto,
  DeliverRetailSaleDto,
  PayRetailSaleDto,
  UpdateRetailSaleCustomerDto,
  UpdateRetailSaleDateDto,
  VoidRetailSalePaymentDto,
  VoidRetailSaleDto,
} from './dto/retail-sale.dto';

/** 'YYYY-MM-DD' suelto, sin hora. */
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Cómo se nombra cada medio en el histórico. Va acá y no en la pantalla porque
 * el resumen del evento se congela escrito: si el nombre lo pusiera el frontend,
 * un histórico viejo cambiaría de texto al cambiar la pantalla.
 */
const PAYMENT_METHOD_LABEL: Record<RetailPaymentMethod, string> = {
  CASH: 'efectivo',
  CARD: 'tarjeta',
  TRANSFER: 'transferencia',
  MIXED: 'mixto',
  OTHER: 'otro medio',
};

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

/**
 * Todo lo que necesita una venta para viajar al frontend.
 *
 * `shipments` trae UN envío y solo el que sigue vivo: es lo que deja que la
 * bandeja de entregas diga "esta venta va en el paquete EN-000003" sin una
 * segunda consulta por cada tarjeta. Una venta pasa por varios envíos a lo largo
 * del tiempo, pero abierto solo puede tener uno a la vez.
 */
const SALE_INCLUDE = {
  items: true,
  customer: { select: { id: true, name: true, phone: true } },
  shipments: {
    where: { shipment: { status: { in: ['DRAFT', 'SENT'] as const } } },
    orderBy: { addedAt: 'desc' as const },
    take: 1,
    select: {
      shipment: { select: { id: true, code: true, status: true } },
    },
  },
  // Los abonos viajan con la venta y no en una llamada aparte: la bandeja de
  // cobros necesita decir "abonó 50.000, faltan 250.000" en cada tarjeta, y son
  // pocas filas por venta. Los anulados VIENEN TAMBIÉN —el histórico no se
  // filtra— y la pantalla los muestra tachados.
  payments: { orderBy: { paidAt: 'asc' as const } },
} satisfies Prisma.RetailSaleInclude;

type SaleWithItems = Prisma.RetailSaleGetPayload<{
  include: typeof SALE_INCLUDE;
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
      deliveryStatus?: RetailDeliveryStatus;
      /**
       * 'OPEN' = todo lo que no está cobrado completo. Existe porque con abonos
       * "por cobrar" dejó de ser un solo estado: filtrar por 'PENDING' escondería
       * justo las ventas a medio pagar, que son las que hay que ir a cobrar.
       */
      paymentStatus?: RetailPaymentStatus | 'OPEN';
      search?: string;
    } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const sales = await this.prisma.retailSale.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...this.searchWhere(filters.search),
        ...(filters.saleType ? { saleType: filters.saleType } : {}),
        ...(filters.deliveryStatus
          ? { deliveryStatus: filters.deliveryStatus }
          : {}),
        ...(filters.paymentStatus
          ? {
              paymentStatus:
                filters.paymentStatus === 'OPEN'
                  ? { not: 'PAID' as const }
                  : filters.paymentStatus,
            }
          : {}),
        ...this.soldAtRange(filters.from, filters.to),
      },
      orderBy: { soldAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 500),
      include: {
        ...SALE_INCLUDE,
      },
    });
    return sales.map((sale) => this.toSaleDto(sale));
  }

  async getSale(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');
    const sale = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id },
      include: {
        ...SALE_INCLUDE,
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

    // BASE CAJA DE VERDAD: EL INGRESO SON LOS ABONOS DEL PERÍODO.
    //
    // Una venta de 45.000 abonada 25.000 el 31 de julio y 20.000 el 5 de agosto
    // reparte su ingreso entre esos dos días, que es cuando entró la plata y lo
    // que el dueño cuadra contra la gaveta. Antes se contaba entera el día en que
    // se vendió —o no se contaba, si estaba fiada—, y ninguno de los dos días
    // decía la verdad.
    //
    // Por eso se piden ABONOS y no ventas. Los anulados no cuentan, y los de una
    // venta anulada tampoco: esa plata volvió.
    const payments = await this.prisma.retailSalePayment.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        voidedAt: null,
        ...this.paidAtRange(from, to),
        sale: {
          status: 'COMPLETED',
          ...(saleType ? { saleType } : {}),
        },
      },
      include: {
        sale: {
          select: {
            id: true,
            totalCOP: true,
            costCOP: true,
            // El flete viaja dentro del total de la venta, así que entra en el
            // ingreso pero NO es margen: hay que poder restarlo del resultado.
            shippingCOP: true,
            saleType: true,
            items: { select: { quantity: true } },
          },
        },
      },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
    });
    const recognized = await this.recognizePayments(payments);

    // LO QUE FALTA POR ENTRAR. Se mira sobre las ventas del rango, no sobre los
    // abonos: la pregunta es "de lo que vendí, cuánto me deben", y una venta sin
    // un solo abono no aparecería en la lista de abonos.
    //
    // Lo que se debe es el SALDO, no el total: decir que un pedido de 300.000 con
    // 250.000 abonados son 300.000 por cobrar es tres veces la deuda real.
    const open = await this.prisma.retailSale.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: 'COMPLETED',
        paymentStatus: { not: 'PAID' },
        ...(saleType ? { saleType } : {}),
        ...this.soldAtRange(from, to),
      },
      select: { totalCOP: true, paidCOP: true },
    });
    const pendingPayment = {
      salesCount: open.length,
      amountCOP: open.reduce(
        (sum, sale) => sum + Math.max(0, sale.totalCOP - sale.paidCOP),
        0,
      ),
    };

    // DEVOLUCIONES: restan el día en que ocurren, no el de la venta. Se piden
    // por `returnedAt` dentro del mismo rango, así que la venta del 2 sigue
    // contada en el 2 y la devolución del 5 pesa en el 5.
    //
    // Va acá y no solo en el dashboard financiero para que "ventas del día"
    // signifique VENTAS NETAS en las dos pantallas: si una restara y la otra no,
    // habría dos cifras distintas para la misma pregunta.
    const returns = await this.prisma.retailSaleReturn.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...this.returnedAtRange(from, to),
      },
      include: { items: true },
    });
    const returnsRevenueCOP = returns.reduce(
      (sum, row) => sum + (row.replacedCOP - row.returnedCOP),
      0,
    );
    // El costo sigue al ingreso: sale el de lo devuelto, entra el de lo que se
    // llevó a cambio. Si no, el margen del período saldría hundido.
    const returnsCostCOP = returns.reduce(
      (sum, row) =>
        sum +
        row.items.reduce(
          (acc, item) =>
            acc +
            item.unitCostCOP *
              item.quantity *
              (item.direction === 'IN' ? -1 : 1),
          0,
        ),
      0,
    );

    const revenueCOP = recognized.revenueCOP + returnsRevenueCOP;
    const costCOP = recognized.cogsCOP + returnsCostCOP;
    // Unidades y conteo de ventas se cuentan sobre las ventas CERRADAS en el
    // período, no sobre los abonos: una unidad no se vende por partes, y
    // repartir media unidad entre dos meses no le sirve a nadie.
    const unitsSold = recognized.closedUnits;
    // Por medio de pago: el del ABONO, no el de la venta. Es la pregunta de la
    // gaveta —cuánto entró en efectivo hoy— y una venta fiada que se cobró por
    // transferencia no puede seguir figurando como efectivo porque así se
    // registró en el mostrador.
    const byPaymentMethod = recognized.byMethod;

    // Desglose normal vs mayorista. Va con costo y margen propios, no solo con
    // ingresos: el punto de separarlos es poder ver que el mayorista factura
    // más y deja menos por unidad, y eso solo se ve comparando márgenes.
    const bySaleType = {
      RETAIL: this.emptyTypeBucket(),
      WHOLESALE: this.emptyTypeBucket(),
    };
    for (const type of ['RETAIL', 'WHOLESALE'] as const) {
      const bucket = bySaleType[type];
      const row = recognized.byType[type];
      bucket.salesCount = row.closedSales;
      bucket.revenueCOP = row.revenueCOP;
      bucket.costCOP = row.cogsCOP;
      bucket.shippingCOP = row.shippingCOP;
      bucket.unitsSold = row.closedUnits;
    }
    for (const bucket of Object.values(bySaleType)) {
      bucket.grossProfitCOP =
        bucket.revenueCOP - bucket.costCOP - bucket.shippingCOP;
      bucket.marginPct = this.marginPct(
        bucket.revenueCOP,
        bucket.costCOP + bucket.shippingCOP,
      );
      bucket.averageTicketCOP = bucket.salesCount
        ? Math.round(bucket.revenueCOP / bucket.salesCount)
        : 0;
    }

    return {
      /** Ventas que se CERRARON en el período (recibieron su último abono). */
      salesCount: recognized.closedSales,
      /** Plata que ENTRÓ en el período, venga de la venta de hoy o de un fiado. */
      revenueCOP,
      costCOP,
      /**
       * EL FLETE NO ES MARGEN.
       *
       * Está dentro de `revenueCOP` porque es plata que entró —el cliente paga
       * mercancía más envío en un solo giro— pero lo que se cobra por mandar el
       * paquete se va en pagar la guía, y esa guía es un gasto de finanzas que
       * nunca pasa por `costCOP` (ahí solo va el costo de la mercancía). Si no
       * se resta acá, cada envío se cuenta como utilidad pura: la tarjeta de
       * cada venta ya lo restaba y el total de arriba no, así que las dos
       * cifras de la misma pantalla no sumaban lo mismo.
       */
      shippingCOP: recognized.shippingCOP,
      grossProfitCOP: revenueCOP - costCOP - recognized.shippingCOP,
      marginPct: this.marginPct(revenueCOP, costCOP + recognized.shippingCOP),
      unitsSold,
      averageTicketCOP: recognized.closedSales
        ? Math.round(revenueCOP / recognized.closedSales)
        : 0,
      byPaymentMethod,
      bySaleType,
      pendingPayment,
      /**
       * De lo que entró, cuánto fue abono de una venta que sigue abierta. YA
       * ESTÁ DENTRO de `revenueCOP` —la plata entró— y viaja aparte para poder
       * decir "de los 800.000 de hoy, 200.000 son abonos de pedidos que todavía
       * no se cierran".
       */
      partialPaymentsCOP: recognized.openPaymentsCOP,
      /**
       * Lo que las devoluciones del período le quitaron (o sumaron) al ingreso.
       * Ya está aplicado en `revenueCOP`; viaja aparte para poder mostrarlo como
       * línea propia y que no parezca que se vendió menos.
       */
      returns: {
        count: returns.length,
        revenueImpactCOP: returnsRevenueCOP,
      },
    };
  }

  private emptyTypeBucket() {
    return {
      salesCount: 0,
      revenueCOP: 0,
      costCOP: 0,
      /** Flete reconocido en este tipo de venta. Va dentro de `revenueCOP`. */
      shippingCOP: 0,
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

      // Una venta con entrega pendiente NO mueve inventario al cobrarse: la
      // mercancía sigue en la estantería hasta que se entregue, y de hecho
      // puede que ni haya llegado todavía. Por eso tampoco se valida stock ni
      // se exige el aroma: el cliente compró "11 unidades", y de cuáles son se
      // decide en cada entrega (ver `addDelivery`).
      const isPending = dto.deliveryStatus === 'PENDING';

      // Un producto que reparte no se puede vender "en general": habría que
      // adivinar de qué aroma descontar, y el reparto quedaría descuadrado
      // contra el total sin forma de saber quién se movió.
      for (const item of dto.items) {
        const product = byId.get(item.productId)!;
        if (isPending || !product.stockOptionId || !product.trackStock)
          continue;
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
        if (!isPending && product.trackStock && product.stock < quantity) {
          throw new BadRequestException(
            `Stock insuficiente de "${product.name}": hay ${product.stock}, se piden ${quantity}`,
          );
        }
      }

      for (const [key, quantity] of requestedQty) {
        const { productId, variantId } = splitStockKey(key);
        if (isPending || !variantId || !byId.get(productId)!.trackStock)
          continue;
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
          // En una venta pendiente nada salió todavía; en una normal, todo.
          deliveredQty: isPending ? 0 : item.quantity,
          variantId: variant?.id ?? null,
          // Congelada en la línea: el recibo tiene que seguir diciendo "Arrurú"
          // aunque después se borre o renombre el aroma.
          variantLabel: variant?.label ?? null,
          name: product.name,
          sku: product.sku,
          quantity: item.quantity,
          unitPriceCOP,
          // COSTO PROMEDIO y no el de reposición: la utilidad mide lo que
          // costó LO QUE SALIÓ. Con `costCOP` (lo que cuesta traer otra), las
          // unidades que entraron más baratas —o gratis por error del
          // proveedor— se vendían costeadas de más y la ganancia salía
          // subestimada. Ver `shared/retail-costing.ts`.
          unitCostCOP: costingCostCOP(product),
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

      // La venta de ayer digitada hoy lleva la fecha de ayer: es el día en que
      // pasó, y finanzas cuenta por `soldAt`. Los sellos de cobro y entrega van
      // con ella —si se vendió y se entregó ayer, no se entregó hoy—.
      const soldAt = this.resolveSoldAt(dto.soldAt);

      const created = await tx.retailSale.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          code: await this.nextSaleCode(tx, ctx.tenantId),
          soldAt,
          customerId: dto.customerId,
          userId: ctx.userId,
          cashSessionId: dto.cashSessionId,
          subtotalCOP,
          discountCOP: saleDiscountCOP,
          totalCOP,
          costCOP,
          paymentMethod: dto.paymentMethod ?? 'CASH',
          saleType: dto.saleType ?? 'RETAIL',
          deliveryStatus: dto.deliveryStatus ?? 'DELIVERED',
          paymentStatus: dto.paymentStatus ?? 'PAID',
          // Se sella ya si sale pagada: el histórico no tiene que adivinar
          // cuándo entró plata que entró en el acto.
          paidAt: dto.paymentStatus === 'PENDING' ? null : soldAt,
          // Se sella la fecha ya si sale entregada: así el histórico no tiene
          // que adivinar cuándo se entregó lo que nunca estuvo pendiente.
          deliveredAt: dto.deliveryStatus === 'PENDING' ? null : soldAt,
          deliveryNote: dto.deliveryNote,
          receivedCOP: dto.receivedCOP,
          changeCOP:
            dto.receivedCOP !== undefined ? dto.receivedCOP - totalCOP : null,
          note: dto.note,
          items: { create: items },
        },
        include: {
          ...SALE_INCLUDE,
        },
      });

      // Solo la venta entregada en el acto mueve inventario aquí. La pendiente
      // lo mueve entrega por entrega.
      if (!isPending) {
        await this.applyStockDelta(tx, ctx, created.id, requestedQty, byId, -1);
      }

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

      // La venta cobrada en el acto nace con su abono. No es burocracia: si el
      // cobro de mostrador no dejara fila, esa venta figuraría con 0 abonado y
      // el saldo diría que el cliente debe todo. Todo lo que entra, entra por
      // acá — una sola forma de contestar "¿cuánto ya pagó?".
      const paidInFull = (dto.paymentStatus ?? 'PAID') !== 'PENDING';
      if (paidInFull && totalCOP > 0) {
        await tx.retailSalePayment.create({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            saleId: created.id,
            amountCOP: totalCOP,
            method: dto.paymentMethod ?? 'CASH',
            paidAt: soldAt,
            userId: ctx.userId,
            userName: ctx.name,
            cashSessionId: dto.cashSessionId,
          },
        });
        await this.syncSalePayment(tx, created.id);
      }

      await this.logSaleEvent(tx, ctx, created.id, {
        kind: 'CREATED',
        summary: paidInFull
          ? `Venta registrada por ${formatCOP(totalCOP)}, cobrada (${PAYMENT_METHOD_LABEL[dto.paymentMethod ?? 'CASH']})`
          : `Venta registrada por ${formatCOP(totalCOP)}, sin cobrar`,
        note: dto.note,
        detail: {
          totalCOP,
          discountCOP: saleDiscountCOP,
          units: items.reduce((sum, item) => sum + item.quantity, 0),
          paid: paidInFull,
        },
        occurredAt: soldAt,
      });

      return created;
    }, this.txOptions);

    return this.getSale(ctx, sale.id);
  }

  /**
   * Registra una entrega parcial y mueve el inventario.
   *
   * Es AQUÍ donde sale la mercancía de una venta pendiente, no al cobrar: hasta
   * este momento las unidades seguían en la estantería. Cada llamada puede
   * entregar parte de una línea (1 de 11 hoy, 5 la semana que viene) y con el
   * aroma que efectivamente salió, que es un dato que al cobrar no existía.
   *
   * La venta pasa a DELIVERED sola, cuando ya no queda nada por entregar.
   */
  async addDelivery(ctx: TenantContext, id: string, dto: DeliverRetailSaleDto) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const sale = await this.prisma.$transaction(
      (tx) => this.deliverInTransaction(tx, ctx, id, dto),
      this.txOptions,
    );

    return this.toSaleDto(sale);
  }

  /**
   * El cuerpo de la entrega, sin abrir transacción propia.
   *
   * Público porque el despacho de un envío entrega varias ventas de una sola
   * vez y tiene que hacerlo TODO dentro de la misma transacción: si la segunda
   * venta falla por falta de stock, la primera no puede quedar entregada y con
   * el inventario ya descontado. `addDelivery` es el mismo trabajo con su
   * transacción alrededor, para la entrega de una venta suelta.
   *
   * Quien llame por acá ya debe haber validado el alcance del tenant.
   */
  async deliverInTransaction(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    id: string,
    dto: DeliverRetailSaleDto,
    /** Paquete en el que sale, cuando la entrega viene de despachar un envío. */
    shipmentId?: string,
  ) {
    const existing = await tx.retailSale.findUniqueOrThrow({
      where: { id },
      include: { items: true },
    });
    if (existing.status === 'VOIDED') {
      throw new BadRequestException(
        'La venta está anulada: no hay nada que entregar',
      );
    }
    if (existing.deliveryStatus === 'DELIVERED') {
      throw new BadRequestException('Esta venta ya figura como entregada');
    }

    const itemById = new Map(existing.items.map((item) => [item.id, item]));
    const productIds = [
      ...new Set(existing.items.map((item) => item.productId)),
    ];
    const products = await tx.retailProduct.findMany({
      where: { id: { in: productIds } },
    });
    const productById = new Map(products.map((p) => [p.id, p]));
    const variants = await tx.retailProductVariant.findMany({
      where: { productId: { in: productIds } },
    });
    const variantById = new Map(variants.map((v) => [v.id, v]));

    // Se valida TODO antes de mover nada: una entrega a medias dejaría stock
    // descontado sin que la línea quede marcada, y eso no se puede deshacer
    // desde la interfaz.
    //
    // SE VALIDA SOBRE LOS TOTALES, no línea por línea. Una misma línea de venta
    // llega repartida en varias líneas de entrega —10 mantequillas salen como 3
    // Arrurú, 4 Sandía y 3 Melón—, y comprobando cada una por separado tres
    // renglones de 10 pasaban el filtro y descontaban 30. Hay que sumar primero
    // y comparar después, en los tres frentes: lo que falta de la venta, el
    // stock del producto y el de cada valor.
    const byItem = new Map<string, number>();
    const byProduct = new Map<string, number>();
    const byVariant = new Map<string, number>();

    for (const line of dto.items) {
      const item = itemById.get(line.saleItemId);
      if (!item) {
        throw new BadRequestException(
          'Una de las líneas no pertenece a esta venta',
        );
      }
      if (line.quantity <= 0) {
        throw new BadRequestException(
          'La cantidad a entregar debe ser mayor a 0',
        );
      }
      byItem.set(
        line.saleItemId,
        (byItem.get(line.saleItemId) ?? 0) + line.quantity,
      );

      const product = productById.get(item.productId)!;
      if (!product.trackStock) continue;
      byProduct.set(
        product.id,
        (byProduct.get(product.id) ?? 0) + line.quantity,
      );

      if (product.stockOptionId) {
        if (!line.variantId) {
          throw new BadRequestException(
            `"${product.name}" reparte existencias por opción: indica cuál estás entregando`,
          );
        }
        const variant = variantById.get(line.variantId);
        if (!variant || variant.productId !== product.id) {
          throw new BadRequestException(
            `La opción elegida no pertenece a "${product.name}"`,
          );
        }
        byVariant.set(
          line.variantId,
          (byVariant.get(line.variantId) ?? 0) + line.quantity,
        );
      }
    }

    for (const [saleItemId, quantity] of byItem) {
      const item = itemById.get(saleItemId)!;
      const remaining = item.quantity - item.deliveredQty;
      if (quantity > remaining) {
        throw new BadRequestException(
          `De "${item.name}" quedan ${remaining} por entregar, no ${quantity}`,
        );
      }
    }

    for (const [productId, quantity] of byProduct) {
      const product = productById.get(productId)!;
      if (product.stock < quantity) {
        throw new BadRequestException(
          `No hay suficiente "${product.name}": hay ${product.stock}, se entregan ${quantity}`,
        );
      }
    }

    for (const [variantId, quantity] of byVariant) {
      const variant = variantById.get(variantId)!;
      const product = productById.get(variant.productId)!;
      if (variant.stock < quantity) {
        throw new BadRequestException(
          `No hay suficiente "${product.name} · ${variant.label}": hay ${variant.stock}, se entregan ${quantity}`,
        );
      }
    }

    for (const line of dto.items) {
      const item = itemById.get(line.saleItemId)!;
      const product = productById.get(item.productId)!;

      await tx.retailSaleDelivery.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          saleId: id,
          saleItemId: item.id,
          variantId: line.variantId ?? null,
          quantity: line.quantity,
          note: dto.note,
          userId: ctx.userId,
          shipmentId: shipmentId ?? null,
        },
      });

      await tx.retailSaleItem.update({
        where: { id: item.id },
        data: { deliveredQty: { increment: line.quantity } },
      });

      if (!product.trackStock) continue;

      const stockAfter = product.stock - line.quantity;
      await tx.retailProduct.update({
        where: { id: product.id },
        data: { stock: stockAfter },
      });
      // Se refresca en memoria porque dos líneas pueden ser del mismo
      // producto y el `stockAfter` del kardex tiene que ir encadenado.
      product.stock = stockAfter;

      if (line.variantId) {
        await tx.retailProductVariant.update({
          where: { id: line.variantId },
          data: { stock: { decrement: line.quantity } },
        });
      }

      await tx.retailStockMovement.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: product.id,
          variantId: line.variantId ?? null,
          type: 'SALE',
          quantity: -line.quantity,
          stockAfter,
          unitCostCOP: item.unitCostCOP,
          reason: 'Entrega de venta pendiente',
          reference: id,
          userId: ctx.userId,
        },
      });
    }

    // ¿Quedó algo pendiente? Se relee en vez de calcularlo a mano para no
    // depender de que el mapa en memoria siga al día.
    const remainingItems = await tx.retailSaleItem.findMany({
      where: { saleId: id },
      select: { quantity: true, deliveredQty: true },
    });
    const fullyDelivered = remainingItems.every(
      (item) => item.deliveredQty >= item.quantity,
    );

    const deliveredUnits = [...byItem.values()].reduce(
      (sum, quantity) => sum + quantity,
      0,
    );
    const pendingUnits = remainingItems.reduce(
      (sum, item) => sum + Math.max(0, item.quantity - item.deliveredQty),
      0,
    );
    await this.logSaleEvent(tx, ctx, id, {
      kind: 'DELIVERY',
      summary: fullyDelivered
        ? `Entrega de ${deliveredUnits} unidad(es): queda entregada completa`
        : `Entrega de ${deliveredUnits} unidad(es): faltan ${pendingUnits}`,
      note: dto.note,
      detail: {
        deliveredUnits,
        pendingUnits,
        ...(shipmentId ? { shipmentId } : {}),
      },
    });

    return tx.retailSale.update({
      where: { id },
      data: {
        ...(fullyDelivered
          ? { deliveryStatus: 'DELIVERED' as const, deliveredAt: new Date() }
          : {}),
        // La nota se acumula: lo que se anotó al vender sigue siendo el
        // contexto de la entrega, así que no se pisa.
        deliveryNote: dto.note
          ? [existing.deliveryNote, dto.note].filter(Boolean).join(' · ')
          : existing.deliveryNote,
      },
      include: {
        ...SALE_INCLUDE,
      },
    });
  }

  /**
   * Registra un abono: plata que entró por esta venta.
   *
   * EL CASO. El cliente manda 50.000 de un pedido de 300.000 y el resto
   * después. Antes esto no se podía anotar —la venta estaba cobrada o no— y lo
   * que se hacía era bajarle el precio a mano, dejando el histórico diciendo que
   * se vendió más barato en vez de que el cliente ya había abonado.
   *
   * NO PUEDE PASARSE DEL SALDO. Cobrar de más no es un abono, es otra cosa (una
   * propina, un anticipo del siguiente pedido) y meterla aquí dejaría la venta
   * diciendo que se pagó más de lo que valía.
   *
   * NO MUEVE FINANZAS. El ingreso se cuenta por la venta entera en su día, como
   * siempre; el abono responde cuánto de esa venta ya entró.
   */
  async addPayment(
    ctx: TenantContext,
    id: string,
    dto: CreateRetailSalePaymentDto,
  ) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const existing = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        totalCOP: true,
        paidCOP: true,
        paymentMethod: true,
      },
    });
    if (existing.status === 'VOIDED') {
      throw new BadRequestException(
        'La venta está anulada: no hay nada que abonar',
      );
    }

    const balanceCOP = existing.totalCOP - existing.paidCOP;
    if (balanceCOP <= 0) {
      throw new BadRequestException('Esta venta ya está cobrada completa');
    }
    if (dto.amountCOP > balanceCOP) {
      throw new BadRequestException(
        `El abono (${dto.amountCOP}) es mayor que el saldo (${balanceCOP})`,
      );
    }

    const method = dto.paymentMethod ?? existing.paymentMethod;
    const paidAt = this.resolveSoldAt(dto.paidAt);

    await this.prisma.$transaction(async (tx) => {
      await tx.retailSalePayment.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          saleId: id,
          amountCOP: dto.amountCOP,
          method,
          paidAt,
          note: dto.note,
          userId: ctx.userId,
          userName: ctx.name,
          cashSessionId: dto.cashSessionId,
        },
      });

      const { paidCOP, totalCOP } = await this.syncSalePayment(tx, id);
      const complete = paidCOP >= totalCOP;

      await this.logSaleEvent(tx, ctx, id, {
        kind: 'PAYMENT',
        summary: complete
          ? `Cobro completo de ${formatCOP(dto.amountCOP)} (${PAYMENT_METHOD_LABEL[method]})`
          : `Abono de ${formatCOP(dto.amountCOP)} (${PAYMENT_METHOD_LABEL[method]}) · quedan ${formatCOP(totalCOP - paidCOP)}`,
        note: dto.note,
        detail: {
          amountCOP: dto.amountCOP,
          method,
          paidCOP,
          balanceCOP: totalCOP - paidCOP,
        },
        occurredAt: paidAt,
      });
    }, this.txOptions);

    return this.getSale(ctx, id);
  }

  /**
   * Anula un abono mal digitado.
   *
   * NO LO BORRA. La plata entró un día y eso no se reescribe; lo que se corrige
   * es el error de digitación, y el error también es parte del histórico. El
   * abono anulado deja de contar para el saldo pero sigue estando, con el motivo
   * y con quién lo anuló.
   */
  async voidPayment(
    ctx: TenantContext,
    id: string,
    paymentId: string,
    dto: VoidRetailSalePaymentDto,
  ) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const payment = await this.prisma.retailSalePayment.findFirst({
      where: { id: paymentId, saleId: id, tenantId: ctx.tenantId },
      select: { id: true, amountCOP: true, method: true, voidedAt: true },
    });
    if (!payment) {
      throw new BadRequestException('Ese abono no es de esta venta');
    }
    if (payment.voidedAt) {
      throw new BadRequestException('Ese abono ya está anulado');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.retailSalePayment.update({
        where: { id: paymentId },
        data: {
          voidedAt: new Date(),
          voidedReason: dto.reason,
          voidedBy: ctx.userId,
        },
      });

      const { paidCOP, totalCOP } = await this.syncSalePayment(tx, id);

      await this.logSaleEvent(tx, ctx, id, {
        kind: 'PAYMENT_VOIDED',
        summary: `Abono anulado de ${formatCOP(payment.amountCOP)} · quedan ${formatCOP(totalCOP - paidCOP)}`,
        note: dto.reason,
        detail: {
          paymentId,
          amountCOP: payment.amountCOP,
          paidCOP,
          balanceCOP: totalCOP - paidCOP,
        },
      });
    }, this.txOptions);

    return this.getSale(ctx, id);
  }

  /**
   * Marca cobrada una venta: abona TODO el saldo que quede de una vez.
   *
   * Sigue existiendo con este nombre porque es la acción del mostrador —"ya me
   * pagó"— y no tiene por qué obligar a escribir el monto cuando paga completo.
   * Por dentro es un abono más, así que queda con su medio, su fecha y su nota
   * en el mismo histórico que los demás.
   */
  async paySale(ctx: TenantContext, id: string, dto: PayRetailSaleDto) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const existing = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id },
      select: { status: true, totalCOP: true, paidCOP: true },
    });
    if (existing.status === 'VOIDED') {
      throw new BadRequestException(
        'La venta está anulada: no hay nada que cobrar',
      );
    }
    const balanceCOP = existing.totalCOP - existing.paidCOP;
    if (balanceCOP <= 0) {
      throw new BadRequestException('Esta venta ya figura como cobrada');
    }

    // El método puede cambiar entre que se fía y se cobra: se anotó "efectivo" y
    // terminó pagando por transferencia. Se guarda también en la venta porque es
    // lo que el recibo afirma.
    if (dto.paymentMethod) {
      await this.prisma.retailSale.update({
        where: { id },
        data: { paymentMethod: dto.paymentMethod },
      });
    }

    return this.addPayment(ctx, id, {
      amountCOP: balanceCOP,
      paymentMethod: dto.paymentMethod,
      note: dto.note,
    });
  }

  /**
   * Devuelve una venta a "por cobrar": anula TODOS sus abonos vigentes.
   *
   * Es la corrección de un error de registro: se cobró en el sistema algo que en
   * realidad se fió. No toca inventario ni la fecha de venta.
   *
   * Existe porque la alternativa sería anular y volver a crear la venta, y eso
   * pierde el consecutivo, la fecha original y el histórico del cliente, además
   * de mover stock dos veces sin motivo. Para deshacer UN abono de varios está
   * `voidPayment`: esto los tumba todos.
   */
  async unpaySale(ctx: TenantContext, id: string, dto: PayRetailSaleDto) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const existing = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id },
      select: { status: true, paidCOP: true },
    });
    if (existing.status === 'VOIDED') {
      throw new BadRequestException('La venta está anulada');
    }
    if (existing.paidCOP <= 0) {
      throw new BadRequestException(
        'Esta venta ya figura como pendiente de cobro',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      const live = await tx.retailSalePayment.findMany({
        where: { saleId: id, voidedAt: null },
        select: { id: true, amountCOP: true },
      });
      await tx.retailSalePayment.updateMany({
        where: { saleId: id, voidedAt: null },
        data: {
          voidedAt: new Date(),
          voidedReason: dto.note ?? 'Se devolvió a por cobrar',
          voidedBy: ctx.userId,
        },
      });

      await this.syncSalePayment(tx, id);

      const total = live.reduce((sum, row) => sum + row.amountCOP, 0);
      await this.logSaleEvent(tx, ctx, id, {
        kind: 'PAYMENT_VOIDED',
        summary:
          live.length === 1
            ? `Vuelve a por cobrar: se anuló el abono de ${formatCOP(total)}`
            : `Vuelve a por cobrar: se anularon ${live.length} abonos por ${formatCOP(total)}`,
        note: dto.note,
        detail: { voidedCount: live.length, amountCOP: total },
      });
    }, this.txOptions);

    return this.getSale(ctx, id);
  }

  /** Una anotación a mano en el histórico. No cambia ningún número. */
  async addSaleNote(
    ctx: TenantContext,
    id: string,
    dto: CreateRetailSaleNoteDto,
  ) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');
    await this.prisma.$transaction(
      (tx) =>
        this.logSaleEvent(tx, ctx, id, {
          kind: 'NOTE',
          summary: 'Anotación',
          note: dto.note,
        }),
      this.txOptions,
    );
    return this.getSale(ctx, id);
  }

  /**
   * El histórico de la venta, del hecho más viejo al más nuevo.
   *
   * En orden ascendente porque se lee como una historia —se registró, se abonó,
   * se corrigió la fecha— y al revés obliga a leer de abajo hacia arriba para
   * entender qué pasó primero.
   */
  async listEvents(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');
    const events = await this.prisma.retailSaleEvent.findMany({
      where: { saleId: id },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
    });
    return events.map((event) => ({
      id: event.id,
      kind: event.kind,
      summary: event.summary,
      note: event.note,
      detail: event.detail,
      userName: event.userName,
      occurredAt: event.occurredAt,
    }));
  }

  /**
   * Recalcula lo abonado y el estado de cobro desde los abonos vigentes.
   *
   * EL ESTADO NO SE ESCRIBE A MANO EN NINGÚN LADO. Es la conclusión de sumar los
   * abonos: si estado y plata se escribieran por separado terminarían
   * contradiciéndose, y una venta diría "cobrada" con saldo pendiente. Los
   * anulados no cuentan; siguen en el histórico, no en la suma.
   *
   * Es público porque el envío también lo necesita: cargarle o quitarle el flete
   * a una venta le cambia el TOTAL, y con el total cambia si lo abonado alcanza
   * o no. Sin volver a pasar por aquí, una venta con abonos podría quedar
   * diciendo "cobrada" después de que le subieran el precio.
   */
  async syncSalePayment(tx: Prisma.TransactionClient, id: string) {
    const sale = await tx.retailSale.findUniqueOrThrow({
      where: { id },
      select: {
        totalCOP: true,
        payments: {
          where: { voidedAt: null },
          orderBy: { paidAt: 'asc' },
          select: { amountCOP: true, paidAt: true },
        },
      },
    });

    const paidCOP = sale.payments.reduce((sum, row) => sum + row.amountCOP, 0);
    const complete = paidCOP >= sale.totalCOP && sale.totalCOP > 0;

    await tx.retailSale.update({
      where: { id },
      data: {
        paidCOP,
        paymentStatus: complete ? 'PAID' : paidCOP > 0 ? 'PARTIAL' : 'PENDING',
        // La fecha de cobro es la del abono que lo COMPLETÓ: es el día en que la
        // venta terminó de entrar. Mientras quede saldo no hay fecha de cobro.
        paidAt: complete
          ? (sale.payments[sale.payments.length - 1]?.paidAt ?? new Date())
          : null,
      },
    });

    return { paidCOP, totalCOP: sale.totalCOP };
  }

  /**
   * Escribe un hecho en el histórico de la venta.
   *
   * El resumen se congela ya escrito: el histórico de una venta vieja tiene que
   * seguir diciendo lo que decía aunque la lógica cambie después. Y el autor se
   * guarda por nombre además de por id, porque el histórico no puede depender de
   * que el usuario siga existiendo.
   */
  private logSaleEvent(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    saleId: string,
    event: {
      kind: RetailSaleEventKind;
      summary: string;
      note?: string | null;
      detail?: Prisma.InputJsonValue;
      occurredAt?: Date;
    },
  ) {
    return tx.retailSaleEvent.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        saleId,
        kind: event.kind,
        summary: event.summary,
        note: event.note ?? null,
        ...(event.detail !== undefined ? { detail: event.detail } : {}),
        userId: ctx.userId,
        userName: ctx.name,
        ...(event.occurredAt ? { occurredAt: event.occurredAt } : {}),
      },
    });
  }

  /**
   * Corrige el día de una venta ya registrada.
   *
   * EL CASO. Se vendió ayer y no hubo tiempo de meterla; se digita hoy y queda
   * pesando en el día equivocado, porque finanzas cuenta las ventas por
   * `soldAt`. Sin esto la única salida era anular y volver a digitar, que mueve
   * el inventario dos veces y le cambia el consecutivo al cliente.
   *
   * SE PUEDE AUNQUE LA VENTA ESTÉ COBRADA Y ENTREGADA. Corregir la fecha no es
   * deshacer nada: la venta ocurrió igual, lo único que estaba mal era el día
   * anotado. Bloquearlo al cerrar dejaría el error escrito para siempre, que es
   * justo lo contrario de tener claridad.
   *
   * QUÉ SE MUEVE CON ELLA. El sello de cobro y el de entrega, cuando estaban
   * puestos EL MISMO DÍA que la venta: eran el reflejo de "se vendió, se cobró y
   * se entregó de una", así que si el día era otro, era otro para los tres. Un
   * fiado que se cobró después mantiene su fecha de cobro: esa plata sí entró
   * ese otro día.
   *
   * LO QUE NO SE MUEVE: los movimientos de inventario ya escritos en el kardex y
   * el arqueo de caja en el que se digitó. El stock salió el día que se digitó
   * —eso pasó de verdad— y el arqueo cuadra contra lo que hubo en la gaveta ese
   * día. Corregir la fecha de la venta no puede reescribir esos dos hechos.
   */
  async updateSaleDate(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailSaleDateDto,
  ) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const existing = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        note: true,
        soldAt: true,
        paidAt: true,
        deliveredAt: true,
        customerId: true,
      },
    });
    if (existing.status === 'VOIDED') {
      throw new BadRequestException(
        'La venta está anulada: no hay fecha que corregir',
      );
    }

    const soldAt = this.resolveSoldAt(dto.soldAt);
    if (calendarDayCO(soldAt) === calendarDayCO(existing.soldAt)) {
      throw new BadRequestException('La venta ya está en ese día');
    }

    const sameDay = (stamp: Date | null) =>
      stamp !== null && calendarDayCO(stamp) === calendarDayCO(existing.soldAt);

    const trace = [
      `Fecha corregida: ${calendarDayCO(existing.soldAt)} → ${calendarDayCO(soldAt)}`,
      dto.reason,
    ]
      .filter(Boolean)
      .join(' · ');

    await this.prisma.$transaction(async (tx) => {
      await tx.retailSale.update({
        where: { id },
        data: {
          soldAt,
          ...(sameDay(existing.paidAt) ? { paidAt: soldAt } : {}),
          ...(sameDay(existing.deliveredAt) ? { deliveredAt: soldAt } : {}),
          note: [existing.note, trace].filter(Boolean).join(' · '),
        },
      });
      await this.logSaleEvent(tx, ctx, id, {
        kind: 'DATE_CHANGED',
        summary: `Fecha corregida: ${calendarDayCO(existing.soldAt)} → ${calendarDayCO(soldAt)}`,
        note: dto.reason,
        detail: {
          fromDay: calendarDayCO(existing.soldAt),
          toDay: calendarDayCO(soldAt),
        },
      });
    }, this.txOptions);

    // La última compra del cliente es la fecha de la venta, no la de digitación.
    if (existing.customerId) {
      await this.refreshLastPurchase(this.prisma, existing.customerId);
    }

    return this.getSale(ctx, id);
  }

  /**
   * Cambia (o pone) el cliente de una venta ya registrada.
   *
   * EL CASO. Se cobró de afán sin asociar a nadie, o se eligió mal de la lista.
   * Sin esto la única salida era anular y volver a digitar: mueve el inventario
   * dos veces y le cambia el consecutivo al cliente.
   *
   * LO QUE HACE DIFÍCIL ESTO no es cambiar el campo, es que el histórico de
   * compras de un cliente —cuánto lleva gastado, cuántas compras, cuándo fue la
   * última— está guardado en el cliente, no calculado. Así que hay que restarle
   * al que sale y sumarle al que entra, y recalcular la última compra de ambos:
   * si la venta que se mueve era justo la última del cliente viejo, su "última
   * compra" pasa a ser otra.
   *
   * NO TOCA UNA VENTA ANULADA: sus totales ya se le habían restado al cliente al
   * anularla, y volver a restarlos dejaría el histórico en negativo.
   */
  async updateSaleCustomer(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailSaleCustomerDto,
  ) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const existing = await this.prisma.retailSale.findUniqueOrThrow({
      where: { id },
      select: {
        status: true,
        customerId: true,
        totalCOP: true,
        customer: { select: { name: true } },
      },
    });
    if (existing.status === 'VOIDED') {
      throw new BadRequestException(
        'La venta está anulada: cambiarle el cliente no corregiría nada',
      );
    }

    const nextId = dto.customerId ?? null;
    if (nextId === existing.customerId) {
      throw new BadRequestException('La venta ya está con ese cliente');
    }

    let nextName: string | null = null;
    if (nextId) {
      const next = await this.prisma.retailCustomer.findFirst({
        where: { id: nextId, tenantId: ctx.tenantId, branchId: ctx.branchId },
        select: { name: true },
      });
      if (!next) {
        throw new BadRequestException('Ese cliente no existe en esta tienda');
      }
      nextName = next.name;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.retailSale.update({
        where: { id },
        data: { customerId: nextId },
      });

      // Al que sale se le quita lo que esta venta le sumaba; al que entra se le
      // pone. Se hace después de mover la venta para que el recálculo de la
      // última compra lea el estado ya nuevo.
      if (existing.customerId) {
        await tx.retailCustomer.update({
          where: { id: existing.customerId },
          data: {
            totalSpentCOP: { decrement: existing.totalCOP },
            salesCount: { decrement: 1 },
          },
        });
        await this.refreshLastPurchase(tx, existing.customerId);
      }
      if (nextId) {
        await tx.retailCustomer.update({
          where: { id: nextId },
          data: {
            totalSpentCOP: { increment: existing.totalCOP },
            salesCount: { increment: 1 },
          },
        });
        await this.refreshLastPurchase(tx, nextId);
      }

      const from = existing.customer?.name ?? 'sin cliente';
      const to = nextName ?? 'sin cliente';
      await this.logSaleEvent(tx, ctx, id, {
        kind: 'CUSTOMER_CHANGED',
        summary: `Cliente: ${from} → ${to}`,
        note: dto.reason,
        detail: {
          fromCustomerId: existing.customerId,
          toCustomerId: nextId,
          amountCOP: existing.totalCOP,
        },
      });
    }, this.txOptions);

    return this.getSale(ctx, id);
  }

  /**
   * Recalcula la fecha de última compra de un cliente desde sus ventas.
   *
   * No se puede arrastrar a mano: si la venta que se movió era justo la última,
   * la fecha guardada apunta a algo que ya no le pertenece.
   */
  private async refreshLastPurchase(
    tx: Prisma.TransactionClient,
    customerId: string,
  ) {
    const last = await tx.retailSale.findFirst({
      where: { customerId, status: 'COMPLETED' },
      orderBy: { soldAt: 'desc' },
      select: { soldAt: true },
    });
    await tx.retailCustomer.update({
      where: { id: customerId },
      data: { lastPurchaseAt: last?.soldAt ?? null },
    });
  }

  /**
   * El instante en que se vendió, a partir de lo que mandó la pantalla.
   *
   * Una cadena 'YYYY-MM-DD' se parsea como UTC por spec, así que "3 de
   * septiembre" en Colombia se volvería el 2 a las 7 de la noche y la venta
   * caería en el día anterior. Por eso el día suelto se ancla a la HORA ACTUAL
   * en Colombia: cae dentro del día que se pidió y conserva un orden razonable
   * frente a las otras ventas de ese día.
   *
   * El futuro se rechaza: una venta que todavía no ocurrió no tiene por qué
   * estar en el sistema, y como el ingreso pesa por esta fecha, dejarla pasar
   * escondería plata en un día que nadie mira.
   */
  private resolveSoldAt(value?: string): Date {
    if (!value) return new Date();

    const now = new Date();
    const parsed = DATE_ONLY_RE.test(value)
      ? new Date(`${value}T${clockTimeCO(now)}${CO_UTC_OFFSET}`)
      : new Date(value);

    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException(`Fecha inválida: ${value}`);
    }
    if (calendarDayCO(parsed) > calendarDayCO(now)) {
      throw new BadRequestException(
        'No se puede fechar una venta en el futuro',
      );
    }
    return parsed;
  }

  /** Anula una venta: devuelve el stock al inventario y la saca de finanzas. */
  async voidSale(ctx: TenantContext, id: string, dto: VoidRetailSaleDto) {
    await this.tenantHelper.assertScopedRecord('retailSale', ctx, id, 'Sale');

    const sale = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.retailSale.findUniqueOrThrow({
        where: { id },
        include: { items: true, deliveries: true },
      });
      if (existing.status === 'VOIDED') {
        throw new BadRequestException('La venta ya está anulada');
      }
      // Anular reingresa TODO lo que salió. Si además hubo una devolución, esa
      // mercancía ya volvió por su propio camino y se contaría dos veces. Y el
      // documento de la devolución quedaría apuntando a una venta que el
      // sistema dice que nunca existió.
      const returnsCount = await tx.retailSaleReturn.count({
        where: { saleId: id },
      });
      if (returnsCount > 0) {
        throw new BadRequestException(
          'Esta venta tiene devoluciones registradas: no se puede anular. ' +
            'Devuelve lo que falte en vez de anularla.',
        );
      }

      // Solo vuelve al inventario lo que EFECTIVAMENTE salió. En una venta con
      // entrega pendiente, lo no entregado nunca se descontó: reingresarlo aquí
      // inflaría el stock con unidades que jamás se movieron.
      //
      // Se devuelve a la misma fila de la que salió: anular la entrega de un
      // Arrurú no puede reingresar la unidad como Sandía. Por eso las entregas
      // mandan sobre la línea — el aroma real está en cada entrega, no en la
      // venta.
      const returnedQty = new Map<string, number>();
      /** Con qué costo salió cada grupo. Es con el que tiene que volver. */
      const returnedCost = new Map<string, number>();
      const itemById = new Map(existing.items.map((item) => [item.id, item]));

      if (existing.deliveries.length > 0) {
        for (const delivery of existing.deliveries) {
          const item = itemById.get(delivery.saleItemId);
          if (!item) continue;
          const key = stockKey(item.productId, delivery.variantId);
          returnedQty.set(key, (returnedQty.get(key) ?? 0) + delivery.quantity);
          returnedCost.set(key, item.unitCostCOP);
        }
      }

      // Ventas de mostrador normales: no tienen filas de entrega porque salieron
      // enteras al cobrarse.
      for (const item of existing.items) {
        const alreadyCounted = existing.deliveries
          .filter((delivery) => delivery.saleItemId === item.id)
          .reduce((sum, delivery) => sum + delivery.quantity, 0);
        const pendingReturn = item.deliveredQty - alreadyCounted;
        if (pendingReturn <= 0) continue;
        const key = stockKey(item.productId, item.variantId);
        returnedQty.set(key, (returnedQty.get(key) ?? 0) + pendingReturn);
        // El costo con el que salió, congelado en la línea al cobrar. Es con lo
        // que tiene que volver a entrar.
        returnedCost.set(key, item.unitCostCOP);
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

      await this.applyStockDelta(
        tx,
        ctx,
        existing.id,
        returnedQty,
        byId,
        1,
        returnedCost,
      );

      if (existing.customerId) {
        await tx.retailCustomer.update({
          where: { id: existing.customerId },
          data: {
            totalSpentCOP: { decrement: existing.totalCOP },
            salesCount: { decrement: 1 },
          },
        });
      }

      await this.logSaleEvent(tx, ctx, id, {
        kind: 'VOIDED',
        summary: `Venta anulada por ${formatCOP(existing.totalCOP)}: la mercancía volvió al inventario`,
        note: dto.reason,
        detail: { totalCOP: existing.totalCOP, paidCOP: existing.paidCOP },
      });

      return tx.retailSale.update({
        where: { id },
        data: {
          status: 'VOIDED',
          voidedAt: new Date(),
          voidedReason: dto.reason,
        },
        include: {
          ...SALE_INCLUDE,
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
      {
        stock: number;
        trackStock: boolean;
        costCOP: number;
        avgCostCOP?: number | null;
      }
    >,
    direction: 1 | -1,
    /**
     * Al ANULAR: con qué costo salió cada grupo, congelado en la línea de la
     * venta. La mercancía tiene que volver valorada como salió, no al promedio
     * de hoy — si entre medias entró mercancía más barata, reintegrarla al
     * promedio actual le cambiaría el costo a posteriori y el valor del
     * inventario dejaría de cuadrar con lo que de verdad se pagó.
     */
    returnUnitCostByKey?: Map<string, number>,
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

      // Anular una venta REINGRESA mercancía, así que mueve el promedio como
      // cualquier otra entrada — al costo con el que salió. Vender no lo mueve:
      // una salida no cambia lo que costó lo que queda.
      let avgCostCOP: number | undefined;
      if (direction === 1 && delta > 0) {
        const value = [...quantities.entries()]
          .filter((entry) => splitStockKey(entry[0]).productId === productId)
          .reduce(
            (sum, [key, qty]) =>
              sum +
              qty * (returnUnitCostByKey?.get(key) ?? costingCostCOP(product)),
            0,
          );
        avgCostCOP = weightedAverageCost({
          stockBefore: product.stock,
          avgCostBefore: costingCostCOP(product),
          quantity: delta,
          unitCostCOP: Math.round(value / delta),
        });
      }

      await tx.retailProduct.update({
        where: { id: productId },
        data: {
          stock: product.stock + delta,
          ...(avgCostCOP !== undefined ? { avgCostCOP } : {}),
        },
      });
    }

    for (const [key, quantity] of quantities) {
      const { productId, variantId } = splitStockKey(key);
      const product = products.get(productId);
      if (!product?.trackStock) continue;
      const returnUnitCost =
        direction === 1 ? returnUnitCostByKey?.get(key) : undefined;

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
          // Al vender sale al promedio. Al anular vuelve al costo CON EL QUE
          // SALIÓ (congelado en la línea de la venta), no al promedio de hoy:
          // si entre medias entró mercancía más barata, reintegrarlas al
          // promedio actual les cambiaría el costo a posteriori y el valor del
          // inventario dejaría de cuadrar con lo que de verdad se pagó.
          unitCostCOP: returnUnitCost ?? costingCostCOP(product),
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

  /**
   * Buscar una venta concreta: por su código o por el cliente.
   *
   * Son los dos caminos por los que se pregunta en el mostrador — "la venta
   * RS-23" o "lo que compró Steven"— y por eso van en el mismo campo en vez de
   * dos: quien busca no quiere elegir primero por dónde está buscando.
   *
   * El código se normaliza para que "23", "rs-23" y "RS-000023" encuentren lo
   * mismo: nadie teclea los ceros de relleno.
   */
  private searchWhere(search?: string): Prisma.RetailSaleWhereInput {
    const term = search?.trim();
    if (!term) return {};

    const digits = term.replace(/\D/g, '');
    const paddedCode = digits ? `RS-${digits.padStart(6, '0')}` : null;

    return {
      OR: [
        { code: { contains: term, mode: 'insensitive' } },
        ...(paddedCode ? [{ code: paddedCode }] : []),
        { customer: { name: { contains: term, mode: 'insensitive' } } },
        { customer: { phone: { contains: term } } },
        // El nombre del producto también: "las mantequillas de la semana pasada"
        // es una búsqueda real, y sin esto habría que recordar el código.
        { items: { some: { name: { contains: term, mode: 'insensitive' } } } },
      ],
    };
  }

  /** Mismo rango, pero por la fecha de la devolución. */
  private returnedAtRange(from?: string, to?: string) {
    if (!from && !to) return {};
    return {
      returnedAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      },
    };
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

  /** Mismo rango, pero por la fecha en que ENTRÓ la plata. */
  private paidAtRange(from?: string, to?: string) {
    if (!from && !to) return {};
    return {
      paidAt: {
        ...(from ? { gte: new Date(from) } : {}),
        ...(to ? { lte: new Date(to) } : {}),
      },
    };
  }

  /**
   * Reparte los abonos del período: ingreso, costo, y qué ventas se cerraron.
   *
   * EL COSTO SIGUE AL INGRESO, PROPORCIONALMENTE. Si de una venta de 45.000 con
   * 30.000 de costo entraron 25.000, el período reconoce 25.000 de ingreso y la
   * parte del costo que le toca. Cargar el costo entero en el primer abono
   * dejaría el primer mes en pérdida y el segundo con margen del 100%: dos meses
   * mintiendo por la misma venta.
   *
   * EL REPARTO NO PIERDE NI INVENTA PESOS. Cada abono se lleva la diferencia
   * entre el costo acumulado hasta él y el del anterior, así que los redondeos
   * se compensan y la suma de todos los abonos de una venta cobrada da EXACTO su
   * costo. Prorratear cada uno por separado dejaría un peso suelto por venta.
   *
   * VENTA CERRADA = la que recibió su último abono dentro del período, y con él
   * completó el total. Lo que se cuenta una sola vez —unidades, número de
   * ventas— se cuenta ahí, en la fecha en que la orden se cierra.
   */
  private async recognizePayments(
    payments: Array<{
      id: string;
      saleId: string;
      amountCOP: number;
      method: RetailPaymentMethod;
      sale: {
        totalCOP: number;
        costCOP: number;
        shippingCOP: number;
        saleType: RetailSaleType;
        items: Array<{ quantity: number }>;
      };
    }>,
  ) {
    const emptyType = () => ({
      revenueCOP: 0,
      cogsCOP: 0,
      shippingCOP: 0,
      closedSales: 0,
      closedUnits: 0,
    });
    const result = {
      revenueCOP: 0,
      cogsCOP: 0,
      /** Flete reconocido en el período. Está dentro de `revenueCOP`. */
      shippingCOP: 0,
      closedSales: 0,
      closedUnits: 0,
      /** De lo que entró, cuánto es de ventas que siguen abiertas. */
      openPaymentsCOP: 0,
      byMethod: {} as Record<string, number>,
      byType: {
        RETAIL: emptyType(),
        WHOLESALE: emptyType(),
      },
    };
    if (payments.length === 0) return result;

    // El libro completo de cada venta tocada, no solo los abonos del período:
    // sin lo anterior no se sabe en qué punto del costo va cada uno.
    const saleIds = [...new Set(payments.map((row) => row.saleId))];
    const ledger = await this.prisma.retailSalePayment.findMany({
      where: { saleId: { in: saleIds }, voidedAt: null },
      orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
      select: { id: true, saleId: true, amountCOP: true },
    });

    const position = new Map<
      string,
      { before: number; after: number; last: boolean }
    >();
    const bySale = new Map<string, typeof ledger>();
    for (const row of ledger) {
      bySale.set(row.saleId, [...(bySale.get(row.saleId) ?? []), row]);
    }
    for (const rows of bySale.values()) {
      let running = 0;
      rows.forEach((row, index) => {
        const before = running;
        running += row.amountCOP;
        position.set(row.id, {
          before,
          after: running,
          last: index === rows.length - 1,
        });
      });
    }

    for (const payment of payments) {
      const { sale } = payment;
      const spot = position.get(payment.id);
      const total = sale.totalCOP;
      // Una venta en 0 no reparte costo: no hay contra qué prorratear.
      const costShare =
        spot && total > 0
          ? Math.round((sale.costCOP * spot.after) / total) -
            Math.round((sale.costCOP * spot.before) / total)
          : 0;
      // El flete se prorratea igual que el costo, y por la misma razón: con
      // abonos, una venta con envío se cobra en pedazos y cada pedazo trae su
      // parte de flete. Reconocerlo entero en el primer abono le quitaría todo
      // el margen a un mes para regalárselo al siguiente.
      const shippingShare =
        spot && total > 0
          ? Math.round((sale.shippingCOP * spot.after) / total) -
            Math.round((sale.shippingCOP * spot.before) / total)
          : 0;
      // Cierra si es el último abono Y alcanzó el total. Un último abono que
      // deja saldo es una venta abierta, no una cerrada.
      const closes = Boolean(spot?.last && spot.after >= total && total > 0);
      const units = closes
        ? sale.items.reduce((sum, item) => sum + item.quantity, 0)
        : 0;

      result.revenueCOP += payment.amountCOP;
      result.cogsCOP += costShare;
      result.shippingCOP += shippingShare;
      if (closes) {
        result.closedSales += 1;
        result.closedUnits += units;
      } else {
        result.openPaymentsCOP += payment.amountCOP;
      }
      result.byMethod[payment.method] =
        (result.byMethod[payment.method] ?? 0) + payment.amountCOP;

      const bucket = result.byType[sale.saleType];
      bucket.revenueCOP += payment.amountCOP;
      bucket.cogsCOP += costShare;
      bucket.shippingCOP += shippingShare;
      if (closes) {
        bucket.closedSales += 1;
        bucket.closedUnits += units;
      }
    }

    return result;
  }

  private toSaleDto(sale: SaleWithItems) {
    return {
      id: sale.id,
      code: sale.code,
      tenantId: sale.tenantId,
      branchId: sale.branchId,
      status: sale.status,
      saleType: sale.saleType,
      deliveryStatus: sale.deliveryStatus,
      paymentStatus: sale.paymentStatus,
      paidAt: sale.paidAt,
      deliveredAt: sale.deliveredAt,
      deliveryNote: sale.deliveryNote,
      customerId: sale.customerId,
      customerName: sale.customer?.name ?? null,
      customerPhone: sale.customer?.phone ?? null,
      // Paquete abierto en el que va, si está en alguno. Con esto la bandeja
      // muestra el vínculo en la tarjeta de la venta y no obliga a ir a buscar
      // el envío para saber si ya quedó agrupada.
      shipmentId: sale.shipments?.[0]?.shipment.id ?? null,
      shipmentCode: sale.shipments?.[0]?.shipment.code ?? null,
      shipmentStatus: sale.shipments?.[0]?.shipment.status ?? null,
      userId: sale.userId,
      cashSessionId: sale.cashSessionId,
      subtotalCOP: sale.subtotalCOP,
      discountCOP: sale.discountCOP,
      // Flete del envío cargado a esta venta. Está DENTRO de `totalCOP`: es lo
      // que hace que el cobro y el ingreso incluyan lo que se cobró por mandar
      // el paquete. 0 en toda venta de mostrador.
      shippingCOP: sale.shippingCOP,
      totalCOP: sale.totalCOP,
      // Cuánto lleva abonado y cuánto falta. La bandeja de cobros los necesita
      // en cada tarjeta: con abonos, "pendiente" ya no significa "debe todo".
      paidCOP: sale.paidCOP,
      balanceCOP: Math.max(0, sale.totalCOP - sale.paidCOP),
      // Los anulados VIAJAN TAMBIÉN, marcados: son parte del histórico y la
      // pantalla los muestra tachados. Filtrarlos acá los escondería.
      payments: sale.payments.map((payment) => ({
        id: payment.id,
        amountCOP: payment.amountCOP,
        method: payment.method,
        paidAt: payment.paidAt,
        note: payment.note,
        userName: payment.userName,
        voidedAt: payment.voidedAt,
        voidedReason: payment.voidedReason,
      })),
      costCOP: sale.costCOP,
      // El flete no es margen: lo que se cobra por él se va en pagar la guía.
      grossProfitCOP: sale.totalCOP - sale.shippingCOP - sale.costCOP,
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
        deliveredQty: item.deliveredQty,
        /** Lo que la tienda todavía le debe al cliente de esta línea. */
        pendingQty: Math.max(0, item.quantity - item.deliveredQty),
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
