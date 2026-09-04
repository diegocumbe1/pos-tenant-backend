import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma, RetailShipmentStatus } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { RetailSalesService } from '../sales/retail-sales.service';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import { formatCOP } from '../../../common/date.util';
import {
  AddSalesToShipmentDto,
  AddShipmentAttachmentDto,
  CancelRetailShipmentDto,
  CreateRetailShipmentDto,
  RetailShipmentDetailsDto,
  ShipRetailShipmentDto,
  UpdateRetailShipmentDto,
  UpdateShipmentAttachmentDto,
} from './dto/retail-shipment.dto';

/**
 * Todo lo que necesita un envío para responder las tres preguntas que se le
 * hacen: qué lleva, qué falta por entregar y qué falta por cobrar.
 */
const SHIPMENT_INCLUDE = {
  customer: { select: { id: true, name: true, phone: true } },
  sales: {
    orderBy: { addedAt: 'asc' as const },
    include: {
      sale: {
        include: {
          items: true,
          customer: { select: { id: true, name: true, phone: true } },
        },
      },
    },
  },
  // Lo que este paquete llevó de verdad. Es distinto de `sales`: una venta puede
  // repartirse entre varios envíos, así que "las ventas del paquete" y "lo que
  // salió en el paquete" no son la misma lista.
  deliveries: {
    orderBy: { deliveredAt: 'asc' as const },
    include: {
      saleItem: { select: { id: true, name: true, saleId: true } },
      variant: { select: { id: true, label: true } },
    },
  },
  attachments: { orderBy: { uploadedAt: 'asc' as const } },
} satisfies Prisma.RetailShipmentInclude;

type ShipmentWithAll = Prisma.RetailShipmentGetPayload<{
  include: typeof SHIPMENT_INCLUDE;
}>;

/** Estados en los que el paquete todavía se está armando. */
const OPEN_STATUSES: RetailShipmentStatus[] = ['DRAFT'];

/** Lo mínimo de una venta para poder recalcular su total con flete. */
const SHIPPING_SALE_SELECT = {
  id: true,
  status: true,
  paymentStatus: true,
  subtotalCOP: true,
  discountCOP: true,
  shippingCOP: true,
  customerId: true,
} satisfies Prisma.RetailSaleSelect;

type ShippingSale = Prisma.RetailSaleGetPayload<{
  select: typeof SHIPPING_SALE_SELECT;
}>;

/**
 * [VERTICAL_RETAIL] Envíos: varias ventas que salen juntas en un paquete.
 *
 * EL PROBLEMA QUE RESUELVE. A un mayorista se le cobró un pedido el lunes y otro
 * el jueves, y los dos viajan en la misma caja con una sola guía. Ese costo de
 * envío no es de ninguna de las dos ventas —es del paquete— y repartirlo entre
 * ellas sería inventar números. Además hay que poder mirar el paquete y saber si
 * ya salió todo o si quedan unidades, y si queda algún saldo por cobrar.
 *
 * QUIÉN MUEVE EL INVENTARIO. Solo el despacho (`ship`). Armar el paquete no
 * saca nada de la estantería: hasta que no se manda, la mercancía está ahí. Al
 * despachar se registran las entregas de las ventas por el MISMO camino que la
 * entrega de mostrador (`RetailSalesService.deliverInTransaction`), así que el
 * kardex, el `deliveredQty` y el cierre de la venta funcionan igual. Todo va en
 * una sola transacción: si la segunda venta no tiene stock, la primera no puede
 * quedar entregada.
 *
 * EL FLETE TIENE DOS LADOS Y LOS DOS PESAN. Lo que se le COBRA al cliente se
 * traslada a una venta (`syncShippingCharge`); lo que CUESTA la guía queda como
 * gasto de finanzas al despachar (`syncShippingExpense`). El envío en sí no
 * crea ingreso propio —eso lo hace la venta que lleva el flete adentro—.
 *
 * El lado del cobro: el flete que se le cobra al cliente es plata que
 * el cliente debe, y mientras vivía solo en el envío no lo veía nadie —ni la
 * bandeja de cobros, que lista ventas, ni finanzas, que suma `totalCOP` de las
 * ventas—. Un paquete de 576.000 con 8.400 de flete decía que faltaban por
 * cobrar 328.500 cuando el cliente debía 336.900, y esos 8.400 no se cobraban
 * nunca. Ahora el flete entra dentro del `totalCOP` de una de sus ventas.
 */
@Injectable()
export class RetailShipmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
    private readonly sales: RetailSalesService,
  ) {}

  async listShipments(
    ctx: TenantContext,
    filters: { status?: RetailShipmentStatus; limit?: number } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const shipments = await this.prisma.retailShipment.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        ...(filters.status ? { status: filters.status } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: Math.min(filters.limit ?? 100, 300),
      include: SHIPMENT_INCLUDE,
    });
    return shipments.map((shipment) => this.toShipmentDto(shipment));
  }

  async getShipment(ctx: TenantContext, id: string) {
    await this.assertShipment(ctx, id);
    const shipment = await this.prisma.retailShipment.findUniqueOrThrow({
      where: { id },
      include: SHIPMENT_INCLUDE,
    });
    return this.toShipmentDto(shipment);
  }

  /**
   * Abre un paquete con una o más ventas.
   *
   * El destinatario se deduce de las ventas cuando no se manda: el caso normal
   * es agrupar pedidos del mismo cliente, y volver a escribir su nombre sería
   * pedir un dato que el sistema ya tiene.
   */
  async createShipment(ctx: TenantContext, dto: CreateRetailShipmentDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    if (dto.customerId) {
      await this.tenantHelper.assertScopedRecord(
        'retailCustomer',
        ctx,
        dto.customerId,
        'Customer',
      );
    }

    const shipment = await this.prisma.$transaction(async (tx) => {
      const sales = await this.assertShippableSales(tx, ctx, dto.saleIds, null);

      const inferred = sales.find((sale) => sale.customerId);
      const created = await tx.retailShipment.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          code: await this.nextShipmentCode(tx, ctx.tenantId),
          userId: ctx.userId,
          customerId: dto.customerId ?? inferred?.customerId ?? null,
          ...this.detailsData(dto, true),
          sales: {
            create: dto.saleIds.map((saleId) => ({ saleId })),
          },
        },
        select: { id: true },
      });

      await this.syncShippingCharge(tx, ctx, created.id);

      return tx.retailShipment.findUniqueOrThrow({
        where: { id: created.id },
        include: SHIPMENT_INCLUDE,
      });
    }, this.txOptions);

    return this.toShipmentDto(shipment);
  }

  /**
   * Cambia los datos logísticos.
   *
   * Se puede editar incluso después de despachado: la guía y el costo real casi
   * nunca se saben en el momento de armar el paquete, y bloquear la edición al
   * enviar obligaría a anotarlos en una libreta aparte.
   */
  async updateShipment(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailShipmentDto,
  ) {
    await this.assertShipment(ctx, id);
    if (dto.customerId) {
      await this.tenantHelper.assertScopedRecord(
        'retailCustomer',
        ctx,
        dto.customerId,
        'Customer',
      );
    }

    const existing = await this.prisma.retailShipment.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    if (existing.status === 'CANCELLED') {
      throw new BadRequestException('El envío está cancelado');
    }

    // En transacción porque cambiar el flete reescribe el total de una venta:
    // el envío y la venta no pueden quedar diciendo cosas distintas.
    const shipment = await this.prisma.$transaction(async (tx) => {
      await tx.retailShipment.update({
        where: { id },
        data: {
          ...(dto.customerId !== undefined
            ? { customerId: dto.customerId }
            : {}),
          ...this.detailsData(dto),
        },
      });
      await this.syncShippingCharge(tx, ctx, id);
      // El costo real de la guía casi siempre se corrige después de despachar.
      await this.syncShippingExpense(tx, id);

      return tx.retailShipment.findUniqueOrThrow({
        where: { id },
        include: SHIPMENT_INCLUDE,
      });
    }, this.txOptions);
    return this.toShipmentDto(shipment);
  }

  /** Suma ventas a un paquete que todavía no ha salido. */
  async addSales(ctx: TenantContext, id: string, dto: AddSalesToShipmentDto) {
    await this.assertShipment(ctx, id);

    const shipment = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.retailShipment.findUniqueOrThrow({
        where: { id },
        select: { status: true },
      });
      this.assertOpen(existing.status);

      await this.assertShippableSales(tx, ctx, dto.saleIds, id);
      await tx.retailShipmentSale.createMany({
        data: dto.saleIds.map((saleId) => ({ shipmentId: id, saleId })),
        skipDuplicates: true,
      });
      // La venta que acaba de entrar puede ser ahora la última sin cobrar, y
      // entonces el flete le corresponde a ella.
      await this.syncShippingCharge(tx, ctx, id);

      return tx.retailShipment.findUniqueOrThrow({
        where: { id },
        include: SHIPMENT_INCLUDE,
      });
    }, this.txOptions);

    return this.toShipmentDto(shipment);
  }

  /**
   * Saca una venta del paquete.
   *
   * Solo mientras no haya salido: una vez despachado, quitar la venta borraría
   * el registro de que su mercancía viajó en esa caja, que es justo lo que el
   * envío existe para recordar.
   */
  async removeSale(ctx: TenantContext, id: string, saleId: string) {
    await this.assertShipment(ctx, id);

    const existing = await this.prisma.retailShipment.findUniqueOrThrow({
      where: { id },
      select: { status: true, _count: { select: { sales: true } } },
    });
    this.assertOpen(existing.status);
    if (existing._count.sales <= 1) {
      throw new BadRequestException(
        'Un envío no puede quedar sin ventas: cancélalo si ya no va a salir',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.retailShipmentSale.deleteMany({
        where: { shipmentId: id, saleId },
      });
      // La venta que sale del paquete no se lleva el flete puesto.
      await this.syncShippingCharge(tx, ctx, id, [saleId]);
    }, this.txOptions);
    return this.getShipment(ctx, id);
  }

  /**
   * Despacha el paquete: aquí es donde sale la mercancía.
   *
   * Sin `items` sale TODO lo que quede pendiente de las ventas del envío, que es
   * el caso normal —el paquete se armó justamente con eso—. Se mandan explícitos
   * para despachar solo una parte (lo demás va en otra caja después) o para
   * decir de qué aroma es cada unidad, dato que al cobrar no existía.
   *
   * Las entregas quedan marcadas con el id del envío, así que después se puede
   * saber qué llevó cada caja aunque una venta se haya repartido entre varias.
   */
  async ship(ctx: TenantContext, id: string, dto: ShipRetailShipmentDto) {
    await this.assertShipment(ctx, id);

    const shipment = await this.prisma.$transaction(async (tx) => {
      const existing = await tx.retailShipment.findUniqueOrThrow({
        where: { id },
        include: {
          sales: { include: { sale: { include: { items: true } } } },
        },
      });
      this.assertOpen(existing.status);
      if (existing.sales.length === 0) {
        throw new BadRequestException('El envío no tiene ventas');
      }

      const saleIds = new Set(existing.sales.map((row) => row.saleId));
      const lines = dto.items?.length
        ? dto.items
        : existing.sales.flatMap((row) =>
            row.sale.items
              .filter((item) => item.quantity > item.deliveredQty)
              .map((item) => ({
                saleId: row.saleId,
                saleItemId: item.id,
                quantity: item.quantity - item.deliveredQty,
                variantId: undefined as string | undefined,
              })),
          );

      if (lines.length === 0) {
        throw new BadRequestException(
          'No queda nada por entregar en las ventas de este envío',
        );
      }
      for (const line of lines) {
        if (!saleIds.has(line.saleId)) {
          throw new BadRequestException(
            'Una de las líneas no pertenece a este envío',
          );
        }
      }

      // Una llamada por venta, todas dentro de esta transacción: el despacho es
      // un solo hecho y no puede quedar a medias con stock ya descontado.
      const bySale = new Map<string, typeof lines>();
      for (const line of lines) {
        bySale.set(line.saleId, [...(bySale.get(line.saleId) ?? []), line]);
      }
      for (const [saleId, saleLines] of bySale) {
        await this.sales.deliverInTransaction(
          tx,
          ctx,
          saleId,
          {
            items: saleLines.map((line) => ({
              saleItemId: line.saleItemId,
              quantity: line.quantity,
              variantId: line.variantId,
            })),
            note: dto.note,
          },
          id,
        );
      }

      await tx.retailShipment.update({
        where: { id },
        data: {
          status: 'SENT',
          sentAt: new Date(),
          note: dto.note
            ? [existing.note, dto.note].filter(Boolean).join(' · ')
            : existing.note,
        },
      });
      // El paquete salió: la guía ya se pagó y el gasto pesa desde hoy.
      await this.syncShippingExpense(tx, id);

      return tx.retailShipment.findUniqueOrThrow({
        where: { id },
        include: SHIPMENT_INCLUDE,
      });
    }, this.txOptions);

    return this.toShipmentDto(shipment);
  }

  /**
   * El cliente confirmó que le llegó.
   *
   * No mueve nada: el inventario salió al despachar. Es el cierre del
   * seguimiento, para que la bandeja deje de mostrar el paquete como en camino.
   */
  async markDelivered(ctx: TenantContext, id: string) {
    await this.assertShipment(ctx, id);
    const existing = await this.prisma.retailShipment.findUniqueOrThrow({
      where: { id },
      select: { status: true },
    });
    if (existing.status !== 'SENT') {
      throw new BadRequestException(
        existing.status === 'DRAFT'
          ? 'El envío todavía no ha salido: despáchalo primero'
          : 'Este envío ya está cerrado',
      );
    }

    const shipment = await this.prisma.retailShipment.update({
      where: { id },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
      include: SHIPMENT_INCLUDE,
    });
    return this.toShipmentDto(shipment);
  }

  /**
   * Cancela un paquete que no va a salir.
   *
   * Solo antes de despachar. Después ya salió mercancía de la estantería y
   * cancelar el envío no la devuelve: para eso está anular la venta, que sí
   * revierte el stock.
   */
  async cancelShipment(
    ctx: TenantContext,
    id: string,
    dto: CancelRetailShipmentDto,
  ) {
    await this.assertShipment(ctx, id);
    const existing = await this.prisma.retailShipment.findUniqueOrThrow({
      where: { id },
      select: { status: true, note: true },
    });
    if (existing.status !== 'DRAFT') {
      throw new BadRequestException(
        'Solo se puede cancelar un envío que no ha salido',
      );
    }

    const shipment = await this.prisma.$transaction(async (tx) => {
      await tx.retailShipment.update({
        where: { id },
        data: {
          status: 'CANCELLED',
          cancelledAt: new Date(),
          note: dto.reason
            ? [existing.note, `Cancelado: ${dto.reason}`]
                .filter(Boolean)
                .join(' · ')
            : existing.note,
        },
      });
      // El paquete no salió: no hay flete que cobrarle a nadie, ni guía que pagar.
      await this.syncShippingCharge(tx, ctx, id);
      await this.syncShippingExpense(tx, id);

      return tx.retailShipment.findUniqueOrThrow({
        where: { id },
        include: SHIPMENT_INCLUDE,
      });
    }, this.txOptions);
    return this.toShipmentDto(shipment);
  }

  // ─── Soportes ──────────────────────────────────────────────────────────────

  async addAttachment(
    ctx: TenantContext,
    id: string,
    dto: AddShipmentAttachmentDto,
  ) {
    await this.assertShipment(ctx, id);
    await this.prisma.retailShipmentAttachment.create({
      data: {
        shipmentId: id,
        kind: dto.kind,
        url: dto.url,
        path: dto.path,
        name: dto.name,
        sizeBytes: dto.sizeBytes,
        description: dto.description,
        userId: ctx.userId,
      },
    });
    return this.getShipment(ctx, id);
  }

  async updateAttachment(
    ctx: TenantContext,
    id: string,
    attachmentId: string,
    dto: UpdateShipmentAttachmentDto,
  ) {
    await this.assertShipment(ctx, id);
    await this.prisma.retailShipmentAttachment.updateMany({
      where: { id: attachmentId, shipmentId: id },
      data: { description: dto.description ?? null },
    });
    return this.getShipment(ctx, id);
  }

  async removeAttachment(ctx: TenantContext, id: string, attachmentId: string) {
    await this.assertShipment(ctx, id);
    await this.prisma.retailShipmentAttachment.deleteMany({
      where: { id: attachmentId, shipmentId: id },
    });
    return this.getShipment(ctx, id);
  }

  // ─── Interno ───────────────────────────────────────────────────────────────

  private assertShipment(ctx: TenantContext, id: string) {
    return this.tenantHelper.assertScopedRecord(
      'retailShipment',
      ctx,
      id,
      'Shipment',
    );
  }

  private assertOpen(status: RetailShipmentStatus) {
    if (!OPEN_STATUSES.includes(status)) {
      throw new BadRequestException(
        status === 'CANCELLED'
          ? 'El envío está cancelado'
          : 'El envío ya salió: arma uno nuevo para lo que falte',
      );
    }
  }

  /**
   * Las ventas se pueden meter en el paquete.
   *
   * Tres condiciones: son de esta tienda, todavía deben mercancía, y no están ya
   * en otro paquete SIN DESPACHAR. Lo último es lo que evita que la misma venta
   * se despache dos veces por descuido; una vez el paquete salió, la venta sí
   * puede entrar a otro con lo que le haya quedado pendiente.
   */
  private async assertShippableSales(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    saleIds: string[],
    currentShipmentId: string | null,
  ) {
    const unique = [...new Set(saleIds)];
    const sales = await tx.retailSale.findMany({
      where: {
        id: { in: unique },
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      include: { items: true },
    });
    if (sales.length !== unique.length) {
      throw new BadRequestException('Hay ventas que no existen en esta tienda');
    }

    for (const sale of sales) {
      if (sale.status === 'VOIDED') {
        throw new BadRequestException(
          `La venta ${sale.code} está anulada: no hay nada que enviar`,
        );
      }
      const pending = sale.items.reduce(
        (sum, item) => sum + Math.max(0, item.quantity - item.deliveredQty),
        0,
      );
      if (pending === 0) {
        throw new BadRequestException(
          `La venta ${sale.code} ya está entregada completa`,
        );
      }
    }

    const alreadyOpen = await tx.retailShipmentSale.findFirst({
      where: {
        saleId: { in: unique },
        shipment: { status: { in: OPEN_STATUSES } },
        ...(currentShipmentId
          ? { shipmentId: { not: currentShipmentId } }
          : {}),
      },
      include: {
        sale: { select: { code: true } },
        shipment: { select: { code: true } },
      },
    });
    if (alreadyOpen) {
      throw new BadRequestException(
        `La venta ${alreadyOpen.sale.code} ya está en el envío ${alreadyOpen.shipment.code}`,
      );
    }

    return sales;
  }

  /**
   * Le carga a UNA venta del paquete el flete que se le cobra al cliente.
   *
   * POR QUÉ EXISTE. El flete es del paquete, no de una venta —por eso vive en el
   * envío—, pero es plata que el cliente paga. La bandeja de cobros lista ventas
   * y finanzas suma `totalCOP` de ventas: cualquier peso que no esté dentro de
   * una venta es un peso que no se cobra y que no aparece en el ingreso. Así que
   * el flete se traslada a una venta, sin dejar de ser del envío.
   *
   * A CUÁL. A la ÚLTIMA venta sin cobrar del paquete. Sin cobrar porque es la
   * que todavía se le va a pasar al cliente; la última y no la primera porque el
   * flete se sabe al despachar, cuando ya se metieron todas.
   *
   * QUÉ NO TOCA. Una venta ya cobrada. Si el flete se cobró junto con ella, esa
   * plata ya entró y quitársela reescribiría un ingreso del pasado; por eso
   * cuando alguna venta cobrada ya lo lleva, no se recoloca nada. Y si no queda
   * ninguna venta sin cobrar, el flete se queda sin cargar y el envío lo dice
   * (`shippingUnbilledCOP`) en vez de perderlo en silencio.
   *
   * `alsoClearSaleIds` son ventas que acaban de salir del paquete: hay que
   * quitarles el flete aunque ya no estén en la lista.
   */
  private async syncShippingCharge(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    shipmentId: string,
    alsoClearSaleIds: string[] = [],
  ) {
    const shipment = await tx.retailShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: {
        code: true,
        status: true,
        shippingChargedCOP: true,
        sales: {
          orderBy: { addedAt: 'asc' },
          select: { sale: { select: SHIPPING_SALE_SELECT } },
        },
      },
    });

    const sales = shipment.sales
      .map((row) => row.sale)
      .filter((sale) => sale.status !== 'VOIDED');
    // Un paquete cancelado no le cobra flete a nadie.
    const charged =
      shipment.status === 'CANCELLED' ? 0 : shipment.shippingChargedCOP;

    const collected = sales.some(
      (sale) => sale.shippingCOP > 0 && sale.paymentStatus === 'PAID',
    );
    const target = collected
      ? undefined
      : [...sales]
          .reverse()
          .find((sale) => sale.paymentStatus === 'PENDING' && charged > 0);

    for (const sale of sales) {
      // La cobrada se deja como está, lleve flete o no.
      if (sale.paymentStatus === 'PAID') continue;
      await this.applyShippingToSale(
        tx,
        ctx,
        shipment.code,
        sale,
        sale.id === target?.id ? charged : 0,
      );
    }

    const orphans = await tx.retailSale.findMany({
      where: { id: { in: alsoClearSaleIds }, shippingCOP: { not: 0 } },
      select: SHIPPING_SALE_SELECT,
    });
    for (const sale of orphans) {
      if (sale.paymentStatus === 'PAID' || sale.status === 'VOIDED') continue;
      await this.applyShippingToSale(tx, ctx, shipment.code, sale, 0);
    }
  }

  /**
   * El costo de la guía como gasto de finanzas.
   *
   * POR QUÉ. Lo que cuesta mandar el paquete es plata que sale de la tienda, y
   * mientras vivió solo en el envío la utilidad quedaba inflada: en EN-000001 se
   * pagaron 35.900 de guía, se le cobraron 8.400 al cliente, y los 27.500 de
   * diferencia no bajaban de ningún lado. Es el mismo agujero que tenía el
   * cobro, del otro lado.
   *
   * CUÁNDO. Solo cuando el paquete SALIÓ. Un borrador todavía no le ha pagado
   * nada a la transportadora, y uno cancelado nunca lo hará; anotar el gasto
   * antes sería un egreso que no ocurrió. La fecha es la del despacho, no la de
   * hoy: el gasto pesa el día en que el paquete salió.
   *
   * IDEMPOTENTE. El id del gasto se deriva del envío, así que corregir el costo
   * de la guía —que casi siempre se sabe después— actualiza el mismo registro en
   * vez de dejar dos. Si el costo vuelve a 0 o el envío se cancela, el gasto se
   * borra: no queda un egreso huérfano que nadie sabe de dónde salió.
   */
  private async syncShippingExpense(
    tx: Prisma.TransactionClient,
    shipmentId: string,
  ) {
    const shipment = await tx.retailShipment.findUniqueOrThrow({
      where: { id: shipmentId },
      select: {
        id: true,
        code: true,
        tenantId: true,
        branchId: true,
        status: true,
        carrier: true,
        trackingCode: true,
        shippingCostCOP: true,
        sentAt: true,
        createdAt: true,
      },
    });

    const id = `shipexp_${shipment.id}`;
    const shipped =
      shipment.status === 'SENT' || shipment.status === 'DELIVERED';

    if (!shipped || shipment.shippingCostCOP <= 0) {
      await tx.expense.deleteMany({ where: { id } });
      return;
    }

    const data = {
      tenantId: shipment.tenantId,
      branchId: shipment.branchId,
      category: 'SALES_SHIPPING',
      concept: [`Flete envío ${shipment.code}`, shipment.carrier]
        .filter(Boolean)
        .join(' · '),
      amountCOP: shipment.shippingCostCOP,
      incurredAt: shipment.sentAt ?? shipment.createdAt,
      note: shipment.trackingCode ? `Guía ${shipment.trackingCode}` : null,
    };

    await tx.expense.upsert({
      where: { id },
      create: { id, ...data },
      update: data,
    });
  }

  /**
   * Escribe el flete en la venta y recalcula su total.
   *
   * El total se reconstruye desde el subtotal en vez de sumarle la diferencia:
   * así el número no se va desviando si algo más lo tocó por el camino.
   */
  private async applyShippingToSale(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    shipmentCode: string,
    sale: ShippingSale,
    amountCOP: number,
  ) {
    if (sale.shippingCOP === amountCOP) return;

    await tx.retailSale.update({
      where: { id: sale.id },
      data: {
        shippingCOP: amountCOP,
        totalCOP: sale.subtotalCOP - sale.discountCOP + amountCOP,
      },
    });

    // El total cambió, así que lo abonado puede haber dejado de alcanzar (o
    // haber empezado a alcanzar). El estado de cobro se vuelve a derivar en vez
    // de quedarse con el que tenía.
    await this.sales.syncSalePayment(tx, sale.id);

    // Queda en el histórico de la venta porque cambia su TOTAL: sin esto, el
    // dueño ve que la venta vale más de lo que se cobró en el mostrador y no
    // tiene dónde enterarse de que fue el flete del paquete.
    await tx.retailSaleEvent.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        saleId: sale.id,
        kind: 'SHIPPING_CHARGED',
        summary:
          amountCOP > 0
            ? `El envío ${shipmentCode} le cargó ${formatCOP(amountCOP)} de flete`
            : `Se le quitó el flete del envío ${shipmentCode}`,
        detail: {
          shipmentCode,
          shippingCOP: amountCOP,
          previousShippingCOP: sale.shippingCOP,
        },
        userId: ctx.userId,
        userName: ctx.name,
      },
    });

    // Lo que el cliente lleva gastado incluye el flete que le cobraste: es
    // plata suya. Se mueve solo la diferencia porque el resto ya estaba contado.
    if (sale.customerId) {
      await tx.retailCustomer.update({
        where: { id: sale.customerId },
        data: { totalSpentCOP: { increment: amountCOP - sale.shippingCOP } },
      });
    }
  }

  /**
   * Los campos logísticos que llegan en el body. Solo viaja lo que se mandó:
   * omitir un campo lo deja como estaba, no lo borra.
   *
   * `copyChargeFromCost` copia el cobro desde el costo cuando no viene escrito.
   * Se usa AL CREAR y no al editar: trasladar el flete tal cual es lo que pasa
   * casi siempre, así que empezar con los dos iguales ahorra escribir el mismo
   * número dos veces. Al editar sería peligroso — un envío que se dejó en 0 a
   * propósito (regalado) volvería a cobrarse solo por corregir el costo de la
   * guía. Mandar `shippingChargedCOP: 0` explícito siempre significa regalado:
   * es un valor, no una ausencia.
   */
  private detailsData(
    dto: RetailShipmentDetailsDto,
    copyChargeFromCost = false,
  ) {
    const charged =
      dto.shippingChargedCOP ??
      (copyChargeFromCost ? dto.shippingCostCOP : undefined);
    return {
      ...(dto.recipientName !== undefined
        ? { recipientName: dto.recipientName }
        : {}),
      ...(dto.recipientPhone !== undefined
        ? { recipientPhone: dto.recipientPhone }
        : {}),
      ...(dto.address !== undefined ? { address: dto.address } : {}),
      ...(dto.carrier !== undefined ? { carrier: dto.carrier } : {}),
      ...(dto.trackingCode !== undefined
        ? { trackingCode: dto.trackingCode }
        : {}),
      ...(dto.shippingCostCOP !== undefined
        ? { shippingCostCOP: dto.shippingCostCOP }
        : {}),
      ...(charged !== undefined ? { shippingChargedCOP: charged } : {}),
      ...(dto.note !== undefined ? { note: dto.note } : {}),
    };
  }

  /** Consecutivo legible por tenant: EN-000001. */
  private async nextShipmentCode(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<string> {
    const last = await tx.retailShipment.findFirst({
      where: { tenantId },
      orderBy: { code: 'desc' },
      select: { code: true },
    });
    const lastNumber = last ? Number(last.code.replace(/\D/g, '')) : 0;
    return `EN-${String(lastNumber + 1).padStart(6, '0')}`;
  }

  /**
   * El envío tal como lo lee la pantalla.
   *
   * Los agregados van resueltos en el backend y no en el frontend porque son la
   * respuesta a las preguntas del negocio —¿ya salió todo? ¿queda saldo?— y
   * tienen que dar lo mismo en la bandeja, en el detalle y en cualquier reporte
   * que venga después.
   */
  private toShipmentDto(shipment: ShipmentWithAll) {
    const sales = shipment.sales.map((row) => {
      const sale = row.sale;
      const totalUnits = sale.items.reduce(
        (sum, item) => sum + item.quantity,
        0,
      );
      const deliveredUnits = sale.items.reduce(
        (sum, item) => sum + Math.min(item.deliveredQty, item.quantity),
        0,
      );
      return {
        saleId: sale.id,
        code: sale.code,
        soldAt: sale.soldAt,
        saleType: sale.saleType,
        status: sale.status,
        deliveryStatus: sale.deliveryStatus,
        paymentStatus: sale.paymentStatus,
        customerName: sale.customer?.name ?? null,
        /** Mercancía + el flete si esta es la venta que lo lleva cargado. */
        totalCOP: sale.totalCOP,
        /** Cuánto de `totalCOP` es flete del envío. 0 en casi todas. */
        shippingCOP: sale.shippingCOP,
        /** Cuánto lleva abonado el cliente de esta venta. */
        paidCOP: sale.paidCOP,
        totalUnits,
        deliveredUnits,
        pendingUnits: Math.max(0, totalUnits - deliveredUnits),
        /**
         * Saldo de ESTA venta: lo que falta, no el total. Con abonos, una venta
         * de 300.000 con 250.000 recibidos debe 50.000; contarla entera diría
         * tres veces la deuda real y el envío mostraría un saldo que no existe.
         */
        pendingPaymentCOP: Math.max(0, sale.totalCOP - sale.paidCOP),
        addedAt: row.addedAt,
        items: sale.items.map((item) => ({
          id: item.id,
          productId: item.productId,
          name: item.name,
          variantLabel: item.variantLabel,
          quantity: item.quantity,
          deliveredQty: item.deliveredQty,
          pendingQty: Math.max(0, item.quantity - item.deliveredQty),
          unitPriceCOP: item.unitPriceCOP,
          totalCOP: item.totalCOP,
        })),
      };
    });

    // La mercancía es el total de las ventas MENOS el flete que una de ellas
    // lleva cargado: si no se descontara, el flete se contaría dos veces —una
    // dentro de la venta y otra en la línea de envío— y el total no cuadraría.
    const goodsTotalCOP = sales.reduce(
      (sum, sale) => sum + sale.totalCOP - sale.shippingCOP,
      0,
    );
    const pendingUnits = sales.reduce(
      (sum, sale) => sum + sale.pendingUnits,
      0,
    );
    // Ya incluye el flete: va dentro del total de la venta que lo lleva.
    const pendingPaymentCOP = sales.reduce(
      (sum, sale) => sum + sale.pendingPaymentCOP,
      0,
    );

    // Quién carga el flete, y cuánto quedó sin cargarle a nadie. Lo segundo pasa
    // cuando ya se cobraron todas las ventas del paquete: no hay dónde meterlo,
    // y el envío tiene que decirlo en vez de dejar el número tirado.
    const shippingCarrier =
      sales.find((sale) => sale.shippingCOP > 0 && sale.status !== 'VOIDED') ??
      null;
    const shippingUnbilledCOP =
      shipment.status === 'CANCELLED'
        ? 0
        : Math.max(
            0,
            shipment.shippingChargedCOP - (shippingCarrier?.shippingCOP ?? 0),
          );

    return {
      id: shipment.id,
      code: shipment.code,
      tenantId: shipment.tenantId,
      branchId: shipment.branchId,
      status: shipment.status,
      customerId: shipment.customerId,
      customerName: shipment.customer?.name ?? null,
      customerPhone: shipment.customer?.phone ?? null,
      recipientName: shipment.recipientName,
      recipientPhone: shipment.recipientPhone,
      address: shipment.address,
      carrier: shipment.carrier,
      trackingCode: shipment.trackingCode,
      shippingCostCOP: shipment.shippingCostCOP,
      shippingChargedCOP: shipment.shippingChargedCOP,
      /**
       * Lo que la tienda gana o pone de su bolsillo por el envío. Negativo = el
       * flete salió más caro de lo que se cobró.
       */
      shippingMarginCOP: shipment.shippingChargedCOP - shipment.shippingCostCOP,
      /** Código de la venta que lleva el flete cargado. null = ninguna. */
      shippingOnSaleCode: shippingCarrier?.code ?? null,
      /** Flete que no se le pudo cargar a ninguna venta: se cobra a mano. */
      shippingUnbilledCOP,
      note: shipment.note,
      sentAt: shipment.sentAt,
      deliveredAt: shipment.deliveredAt,
      cancelledAt: shipment.cancelledAt,
      createdAt: shipment.createdAt,
      updatedAt: shipment.updatedAt,
      sales,
      salesCount: sales.length,
      /** Valor de la mercancía del paquete: la suma de sus ventas. */
      goodsTotalCOP,
      /** Mercancía + lo que se le cobra al cliente por el envío. */
      totalCOP: goodsTotalCOP + shipment.shippingChargedCOP,
      pendingUnits,
      isFullyDelivered: pendingUnits === 0,
      /** Plata que las ventas de este paquete todavía deben. */
      pendingPaymentCOP,
      carried: shipment.deliveries.map((delivery) => ({
        id: delivery.id,
        saleId: delivery.saleItem.saleId,
        saleItemId: delivery.saleItemId,
        name: delivery.saleItem.name,
        variantLabel: delivery.variant?.label ?? null,
        quantity: delivery.quantity,
        deliveredAt: delivery.deliveredAt,
      })),
      attachments: shipment.attachments.map((attachment) => ({
        id: attachment.id,
        kind: attachment.kind,
        url: attachment.url,
        path: attachment.path,
        name: attachment.name,
        sizeBytes: attachment.sizeBytes,
        description: attachment.description,
        uploadedAt: attachment.uploadedAt,
      })),
    };
  }

  private readonly txOptions = { timeout: 20_000 };
}
