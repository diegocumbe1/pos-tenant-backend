import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  Prisma,
  RetailPurchaseItem,
  RetailPurchaseStatus,
  RetailSupplierLedgerKind,
} from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { weightedAverageCost } from '../../shared/retail-costing';
import { RetailTenantHelper } from '../../shared/retail-tenant.helper';
import {
  CreateRetailPurchaseItemDto,
  LinkPurchaseExpenseDto,
  ReceiveRetailPurchaseItemDto,
  ResolveRetailPurchaseVarianceDto,
  UpdateRetailPurchaseItemDto,
} from './dto/retail-purchases.dto';

/**
 * Todo lo que una línea de pedido necesita para viajar al frontend.
 *
 * `receipts` va en el listado y no solo en el detalle porque la fila tiene que
 * poder decir "12 de 24, en 1 viaje" sin una segunda consulta por cada línea.
 * Son pocas filas por pedido: un pedido que llega en más de dos o tres tandas es
 * rarísimo.
 */
const PURCHASE_INCLUDE = {
  product: { select: { id: true, name: true, sku: true, stock: true } },
  receipts: { orderBy: { receivedAt: 'asc' as const } },
  supplierRef: { select: { id: true, name: true } },
} satisfies Prisma.RetailPurchaseItemInclude;

type PurchaseWithRelations = Prisma.RetailPurchaseItemGetPayload<{
  include: typeof PURCHASE_INCLUDE;
}>;

/** Estados que siguen "vivos" en la lista: lo que todavía hay que atender. */
const OPEN_STATUSES: RetailPurchaseStatus[] = [
  'PENDING',
  'ORDERED',
  // Recibido a medias sigue abierto: puede seguir llegando mercancía y todavía
  // hay algo que atender. Dejarlo fuera lo escondería de la lista justo cuando
  // es lo que hay que perseguir.
  'PARTIALLY_RECEIVED',
];

/**
 * Lista de pedidos al proveedor: el paso previo al catálogo y al inventario.
 *
 * Funciona como una lista de tareas — se apunta, se marca "pedido" y se marca
 * "recibido" — y cada marca deja su fecha, que es lo que permite ver qué lleva
 * días sin pedirse o sin llegar. El inventario solo se toca al recibir, y
 * siempre a través del kardex, para que stock y movimientos nunca divergan.
 */
@Injectable()
export class RetailPurchasesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: RetailTenantHelper,
  ) {}

  async list(
    ctx: TenantContext,
    filters: { status?: RetailPurchaseStatus; open?: boolean } = {},
  ) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const items = await this.prisma.retailPurchaseItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        ...(filters.status ? { status: filters.status } : {}),
        ...(filters.open ? { status: { in: OPEN_STATUSES } } : {}),
      },
      // Lo urgente arriba y, dentro de eso, lo más viejo primero: lo que lleva
      // más tiempo apuntado es lo que más urge resolver.
      orderBy: [{ isUrgent: 'desc' }, { createdAt: 'asc' }],
      include: PURCHASE_INCLUDE,
    });
    return items.map((item) => this.toDto(item));
  }

  /** Contadores para la cabecera: qué falta pedir, qué está en camino. */
  async getSummary(ctx: TenantContext) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const grouped = await this.prisma.retailPurchaseItem.groupBy({
      by: ['status'],
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
      },
      _count: { _all: true },
      _sum: { quantity: true },
    });

    const countOf = (status: RetailPurchaseStatus) =>
      grouped.find((row) => row.status === status)?._count._all ?? 0;

    // Valor estimado de lo que falta comprar: sirve para saber cuánta plata hay
    // que separar antes de ir donde el proveedor.
    const open = await this.prisma.retailPurchaseItem.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        deletedAt: null,
        status: { in: OPEN_STATUSES },
      },
      select: { quantity: true, estimatedCostCOP: true },
    });

    return {
      pendingCount: countOf('PENDING'),
      orderedCount: countOf('ORDERED'),
      receivedCount: countOf('RECEIVED'),
      partiallyReceivedCount: countOf('PARTIALLY_RECEIVED'),
      cancelledCount: countOf('CANCELLED'),
      openCount:
        countOf('PENDING') + countOf('ORDERED') + countOf('PARTIALLY_RECEIVED'),
      estimatedOpenCostCOP: open.reduce(
        (sum, item) => sum + (item.estimatedCostCOP ?? 0) * item.quantity,
        0,
      ),
    };
  }

  async create(ctx: TenantContext, dto: CreateRetailPurchaseItemDto) {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    if (dto.productId) {
      await this.tenantHelper.assertScopedRecord(
        'retailProduct',
        ctx,
        dto.productId,
        'Product',
      );
    }

    const item = await this.prisma.retailPurchaseItem.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        productId: dto.productId ?? null,
        name: dto.name.trim(),
        quantity: dto.quantity ?? 1,
        unit: dto.unit?.trim() || null,
        supplier: dto.supplier?.trim() || null,
        supplierId: await this.resolveSupplierId(ctx, dto),
        estimatedCostCOP: dto.estimatedCostCOP,
        note: dto.note?.trim() || null,
        isUrgent: dto.isUrgent ?? false,
        createdById: ctx.userId,
      },
      include: PURCHASE_INCLUDE,
    });
    return this.toDto(item);
  }

  async update(
    ctx: TenantContext,
    id: string,
    dto: UpdateRetailPurchaseItemDto,
  ) {
    await this.assertOwnItem(ctx, id);
    if (dto.productId) {
      await this.tenantHelper.assertScopedRecord(
        'retailProduct',
        ctx,
        dto.productId,
        'Product',
      );
    }

    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: {
        productId: dto.productId,
        name: dto.name?.trim(),
        quantity: dto.quantity,
        unit: dto.unit === undefined ? undefined : dto.unit.trim() || null,
        supplier:
          dto.supplier === undefined ? undefined : dto.supplier.trim() || null,
        // Reescribir el nombre reapunta la ficha: si alguien corrige el
        // proveedor de un pedido, su saldo tiene que moverse con él.
        ...(dto.supplier !== undefined || dto.supplierId !== undefined
          ? { supplierId: await this.resolveSupplierId(ctx, dto) }
          : {}),
        estimatedCostCOP: dto.estimatedCostCOP,
        note: dto.note === undefined ? undefined : dto.note.trim() || null,
        isUrgent: dto.isUrgent,
      },
      include: PURCHASE_INCLUDE,
    });
    return this.toDto(item);
  }

  /**
   * Enlaza un gasto de Finanzas a este pedido, como un pago más.
   *
   * Se agrega, nunca se reemplaza: un pedido se paga en varios giros (se abona
   * al pedirlo, se completa al recibirlo) y cada giro es una salida de plata
   * con su propia fecha. Pisar el enlace anterior dejaría el primer gasto
   * huérfano en Finanzas y haría mentir al flujo de caja de los dos días.
   *
   * Idempotente a propósito: el frontend enlaza en paralelo todas las líneas de
   * un pedido conjunto y reintenta si algo falla; el mismo gasto dos veces no
   * puede contar doble.
   */
  async linkExpense(
    ctx: TenantContext,
    id: string,
    dto: LinkPurchaseExpenseDto,
  ) {
    const current = await this.assertOwnItem(ctx, id);
    const expenseId = dto.expenseId.trim();
    if (!expenseId) {
      throw new BadRequestException('El gasto a enlazar no puede ir vacío');
    }

    const expense = await this.prisma.expense.findUnique({
      where: { id: expenseId },
      select: { id: true, tenantId: true, branchId: true, amountCOP: true },
    });
    // Un id de gasto que no existe (o de otra sede) dejaría el pedido diciendo
    // "pagado" contra algo que nadie puede abrir desde Finanzas.
    if (
      !expense ||
      expense.tenantId !== ctx.tenantId ||
      expense.branchId !== ctx.branchId
    ) {
      throw new NotFoundException(`Expense ${expenseId} not found`);
    }

    const field = dto.kind === 'SHIPPING' ? 'shippingExpenseIds' : 'expenseIds';
    if (current[field].includes(expenseId)) {
      return this.toDto(await this.findWithProduct(id));
    }

    const item = await this.prisma.$transaction(async (tx) => {
      // UN GIRO, UNA FILA. El mismo gasto se enlaza a TODAS las líneas de un
      // pedido conjunto, así que escribir el pago por cada enlace lo contaría
      // tantas veces como líneas tenga el pedido y el saldo quedaría absurdo.
      // Se busca primero si ese gasto ya entró al libro.
      if (current.supplierId) {
        const already = await tx.retailSupplierLedgerEntry.findFirst({
          where: {
            supplierId: current.supplierId,
            expenseId,
            kind: 'PAYMENT',
          },
          select: { id: true },
        });
        if (!already) {
          await this.writeLedgerEntry(tx, ctx, {
            supplierId: current.supplierId,
            kind: 'PAYMENT',
            // Negativo: girar baja lo que se le debe.
            amountCOP: -expense.amountCOP,
            purchaseItemId: id,
            expenseId,
            note: 'Giro registrado en Finanzas',
          });
        }
      }

      return tx.retailPurchaseItem.update({
        where: { id },
        data: { [field]: { push: expenseId } },
        include: PURCHASE_INCLUDE,
      });
    }, this.txOptions);
    return this.toDto(item);
  }

  /**
   * Quita el enlace a un gasto. No borra el gasto de Finanzas: la plata salió
   * igual, lo que se corrige es a qué pedido se le atribuyó.
   *
   * Busca en las dos listas porque quien desenlaza está mirando un pago
   * concreto, no pensando en si fue mercancía o flete.
   */
  async unlinkExpense(ctx: TenantContext, id: string, expenseId: string) {
    const current = await this.assertOwnItem(ctx, id);
    const item = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.retailPurchaseItem.update({
        where: { id },
        data: {
          expenseIds: current.expenseIds.filter((x) => x !== expenseId),
          shippingExpenseIds: current.shippingExpenseIds.filter(
            (x) => x !== expenseId,
          ),
        },
        include: PURCHASE_INCLUDE,
      });

      // Desenlazar es CORREGIR a quién se le atribuyó el giro, no devolverlo:
      // el gasto sigue en Finanzas. Por eso la fila del libro se borra en vez de
      // contra-asentarse — nunca debió existir en esa cuenta. Solo cuando ya no
      // queda ninguna línea de ese proveedor apuntando al gasto: mientras alguna
      // lo referencie, el pago sí es suyo.
      if (current.supplierId) {
        const stillLinked = await tx.retailPurchaseItem.findFirst({
          where: {
            supplierId: current.supplierId,
            deletedAt: null,
            OR: [
              { expenseIds: { has: expenseId } },
              { shippingExpenseIds: { has: expenseId } },
            ],
          },
          select: { id: true },
        });
        if (!stillLinked) {
          await tx.retailSupplierLedgerEntry.deleteMany({
            where: {
              supplierId: current.supplierId,
              expenseId,
              kind: 'PAYMENT',
            },
          });
        }
      }

      return updated;
    }, this.txOptions);
    return this.toDto(item);
  }

  /**
   * Marca (o desmarca) el ítem como pedido al proveedor. Desmarcar borra la
   * fecha: si se apuntó por error, la lista no debe mentir diciendo que ya se
   * pidió.
   */
  async setOrdered(ctx: TenantContext, id: string, ordered: boolean) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status === 'RECEIVED') {
      throw new BadRequestException(
        'El ítem ya llegó: no se puede volver a marcar como pedido',
      );
    }

    const item = await this.prisma.$transaction(async (tx) => {
      // CONFIRMAR EL PEDIDO ES CONTRAER LA DEUDA, no girarla. Es lo que hace que
      // "pedidos que pago después" deje de ser un caso especial: son un
      // PURCHASE sin su PAYMENT, y el saldo lo muestra solo.
      //
      // Al desmarcar se escribe el contrario en vez de borrar la fila: el libro
      // es un histórico, y una corrección tiene que verse como corrección.
      if (current.supplierId) {
        const amount = (current.estimatedCostCOP ?? 0) * current.quantity;
        await this.writeLedgerEntry(tx, ctx, {
          supplierId: current.supplierId,
          kind: ordered ? 'PURCHASE' : 'ADJUSTMENT',
          amountCOP: ordered ? amount : -amount,
          purchaseItemId: id,
          note: ordered
            ? `Pedido confirmado: ${current.quantity}× ${current.name}`
            : `Se desmarcó el pedido de "${current.name}"`,
        });
      }

      return tx.retailPurchaseItem.update({
        where: { id },
        data: ordered
          ? {
              status: 'ORDERED',
              orderedAt: new Date(),
              orderedById: ctx.userId,
            }
          : { status: 'PENDING', orderedAt: null, orderedById: null },
        include: PURCHASE_INCLUDE,
      });
    }, this.txOptions);
    return this.toDto(item);
  }

  /**
   * Registra UNA TANDA que llegó, y si la línea está enlazada a un producto que
   * controla stock deja su entrada en el kardex en el mismo commit. Ese es el
   * puente con el inventario: la lista no mueve existencias por su cuenta.
   *
   * Se puede llamar varias veces sobre la misma línea: se piden 24 y llegan 12
   * hoy y 12 la semana entrante. `receivedQuantity` acumula, y la línea solo
   * pasa a RECEIVED cuando se completó lo pedido — o cuando alguien la cierra a
   * mano con `closeLine`, que es lo que convierte un faltante en definitivo.
   *
   * MIENTRAS LLEGA, NO HAY FALTANTE. Una línea a medias es mercancía en
   * tránsito, no un reclamo al proveedor. Por eso acá no se marca ninguna
   * discrepancia por lo que falta; solo por lo que sobra, que sí es un hecho
   * consumado en el momento en que se descarga.
   */
  async receive(
    ctx: TenantContext,
    id: string,
    dto: ReceiveRetailPurchaseItemDto,
  ) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status === 'RECEIVED') {
      throw new BadRequestException(
        'Esta línea ya se cerró: si llegó más, reábrela o apunta un pedido nuevo',
      );
    }
    if (current.status === 'CANCELLED') {
      throw new BadRequestException('El ítem está cancelado');
    }

    const alreadyReceived = current.receivedQuantity ?? 0;
    const remaining = Math.max(0, current.quantity - alreadyReceived);
    // Sin cantidad explícita se asume que llegó lo que faltaba, que es el caso
    // normal de una línea que se recibe de una sola vez.
    const received = dto.quantity ?? remaining;
    if (received <= 0) {
      throw new BadRequestException(
        'La cantidad recibida tiene que ser mayor a 0',
      );
    }
    const unitCost = dto.unitCostCOP ?? current.estimatedCostCOP ?? undefined;

    const totalReceived = alreadyReceived + received;
    // Se cierra sola cuando ya llegó todo lo pedido. Si llegó de más también:
    // no hay nada más que esperar, y el sobrante es un hecho.
    const isComplete = totalReceived >= current.quantity;
    const overage = Math.max(0, totalReceived - current.quantity);

    // EL SOBRANTE SE REPARTE. Cuando el proveedor manda de más, parte se puede
    // acordar y pagar y parte puede ser error suyo. De 16 de más se pagan 12 y
    // las otras 4 entran como error: son dos hechos distintos dentro de la misma
    // llegada, y tratarlos como uno solo obliga a mentir en uno de los dos.
    //
    // Lo que no se paga entra a $0. Meterlo al inventario valorado al costo
    // normal inventa plata por dos lados: infla el valor del inventario y le
    // carga al proveedor una deuda que no existe.
    //
    // El tope es lo que sobra de ESTA tanda: si llegaron 20 de un pedido de 12,
    // hay 8 en juego, no 20.
    const overageHere = Math.min(overage, received);
    if (dto.overagePaidQty !== undefined && dto.overagePaidQty > overageHere) {
      throw new BadRequestException(
        `Solo llegaron ${overageHere} de más: no se pueden pagar ${dto.overagePaidQty}`,
      );
    }
    // Omitirlo = se pagan todas, que es como se comportaba antes.
    const overagePaid = dto.overagePaidQty ?? overageHere;
    const freeUnits = overageHere - overagePaid;
    const paidUnits = received - freeUnits;

    const item = await this.prisma.$transaction(async (tx) => {
      let stockMovementId: string | null = null;

      const product = current.productId
        ? await tx.retailProduct.findUnique({
            where: { id: current.productId },
            select: {
              id: true,
              stock: true,
              trackStock: true,
              costCOP: true,
              avgCostCOP: true,
            },
          })
        : null;

      const touchesInventory =
        dto.addToInventory !== false &&
        received > 0 &&
        product !== null &&
        product.trackStock;

      if (touchesInventory) {
        // DOS MOVIMIENTOS CUANDO PARTE LLEGÓ GRATIS, no uno con el costo
        // promediado: el kardex tiene que poder decir "12 entraron a 16.000 y 8
        // entraron a 0 por error del proveedor". Un costo mezclado esconde
        // exactamente el hecho que se quiere poder auditar después.
        let stockAfter = product.stock;
        // El promedio se recalcula ENTRADA POR ENTRADA y en orden: las pagadas
        // primero y las gratis después. Hacerlo con un costo mezclado daría
        // otro número, porque el promedio pondera por unidades y las dos tandas
        // entran sobre un stock distinto.
        let avgCost = product.avgCostCOP ?? product.costCOP;

        if (paidUnits > 0) {
          avgCost = weightedAverageCost({
            stockBefore: stockAfter,
            avgCostBefore: avgCost,
            quantity: paidUnits,
            unitCostCOP: unitCost ?? avgCost,
          });
          stockAfter += paidUnits;
          const movement = await tx.retailStockMovement.create({
            data: {
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              productId: product.id,
              type: 'PURCHASE',
              quantity: paidUnits,
              stockAfter,
              unitCostCOP: unitCost,
              reason: `Pedido recibido: ${current.name}`,
              reference: dto.reference ?? `purchase:${current.id}`,
              userId: ctx.userId,
            },
          });
          stockMovementId = movement.id;
        }

        if (freeUnits > 0) {
          // Entran a 0 y por eso BAJAN el promedio: es justo lo que hace que la
          // utilidad de venderlas deje de estar subestimada.
          avgCost = weightedAverageCost({
            stockBefore: stockAfter,
            avgCostBefore: avgCost,
            quantity: freeUnits,
            unitCostCOP: 0,
          });
          stockAfter += freeUnits;
          const movement = await tx.retailStockMovement.create({
            data: {
              tenantId: ctx.tenantId,
              branchId: ctx.branchId,
              productId: product.id,
              type: 'PURCHASE',
              quantity: freeUnits,
              stockAfter,
              // CERO A PROPÓSITO. No se pagaron, así que valorarlas costaría
              // plata que nunca salió.
              unitCostCOP: 0,
              reason: `Sobrante sin costo (error del proveedor): ${current.name}`,
              reference: dto.reference ?? `purchase:${current.id}`,
              userId: ctx.userId,
            },
          });
          // Si TODO lo de esta tanda llegó gratis, este es el movimiento que
          // representa la recepción.
          stockMovementId = stockMovementId ?? movement.id;
        }

        await tx.retailProduct.update({
          where: { id: product.id },
          data: {
            stock: stockAfter,
            avgCostCOP: avgCost,
            // El costo de REPOSICIÓN sigue siendo el que se paga por una
            // unidad: es con lo que se repone, y es el que manda al poner
            // precios. Que unas hayan llegado de regalo no hace más barato
            // traer la siguiente.
            ...(unitCost !== undefined && paidUnits > 0
              ? { costCOP: unitCost }
              : {}),
          },
        });
      }

      // La tanda queda como su propia fila: es lo que permite ver después que
      // de las 24 llegaron 12 el 20/08 y 12 el 02/09, con su remisión cada una.
      await tx.retailPurchaseReceipt.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          purchaseItemId: id,
          quantity: received,
          // El costo de la tanda es el que se pagó. Cuántas de esas llegaron
          // gratis se lee en el kardex, que tiene un movimiento por cada cosa.
          unitCostCOP: paidUnits > 0 ? (unitCost ?? null) : 0,
          reference: dto.reference?.trim() || null,
          note: dto.varianceNote?.trim() || null,
          stockMovementId,
          userId: ctx.userId,
        },
      });

      // COMPRA DE UNA Y ANOTA DESPUÉS. Si nunca se marcó como pedido, el
      // movimiento de compra no se escribió nunca, y el libro tendría los giros
      // sin la deuda que vienen a pagar: el saldo diría que el proveedor debe
      // plata que en realidad se le estaba pagando. Se escribe acá, la primera
      // vez que llega mercancía de esa línea.
      if (!current.orderedAt && alreadyReceived === 0 && current.supplierId) {
        await this.writeLedgerEntry(tx, ctx, {
          supplierId: current.supplierId,
          kind: 'PURCHASE',
          amountCOP: (current.estimatedCostCOP ?? 0) * current.quantity,
          purchaseItemId: id,
          note: `Compra registrada al recibir: ${current.quantity}× ${current.name}`,
        });
      }

      // Lo que llegó de más ya es plata que se le debe al proveedor: la
      // mercancía está en la bodega y se va a vender. Si se decide devolverla,
      // eso será otro movimiento, no la ausencia de este.
      //
      // Salvo que se marque que no se va a pagar: ahí no hay deuda que anotar,
      // y escribirla para después contra-asentarla solo ensuciaría el extracto.
      if (overagePaid > 0 && current.supplierId) {
        await this.writeLedgerEntry(tx, ctx, {
          supplierId: current.supplierId,
          kind: 'OVERAGE',
          amountCOP: overagePaid * (unitCost ?? 0),
          purchaseItemId: id,
          note:
            freeUnits > 0
              ? `De ${overageHere} de más de "${current.name}", se acordaron ${overagePaid}; ${freeUnits} entraron sin costo`
              : `Llegaron ${overagePaid} de más de "${current.name}"`,
        });
      }

      return tx.retailPurchaseItem.update({
        where: { id },
        data: {
          status: isComplete ? 'RECEIVED' : 'PARTIALLY_RECEIVED',
          // La fecha de recibido es la de la ÚLTIMA tanda: es cuándo se terminó
          // de recibir. El detalle de cada viaje vive en `receipts`.
          receivedAt: new Date(),
          receivedById: ctx.userId,
          // Recibir algo que nunca se marcó como pedido igual deja la fecha:
          // en la práctica se compra de una y se anota después.
          orderedAt: current.orderedAt ?? new Date(),
          orderedById: current.orderedById ?? ctx.userId,
          // `quantity` NO se toca: es lo que se pidió, y pisarlo acá era lo que
          // hacía imposible saber después que el proveedor quedó debiendo.
          receivedQuantity: totalReceived,
          // El costo pactado tampoco se pisa. Si la factura vino a otro precio,
          // ese es un hecho aparte y vale la pena poder compararlos.
          ...(dto.unitCostCOP !== undefined
            ? { receivedUnitCostCOP: dto.unitCostCOP }
            : {}),
          // Solo el sobrante abre cuenta acá. El faltante espera a que la línea
          // se cierre: hasta entonces la mercancía puede seguir llegando.
          //
          // Un sobrante enteramente asumido nace ya resuelto (ACCEPTED): no hay
          // nada que perseguir con el proveedor, y dejarlo PENDING lo pondría en
          // la lista de cuentas abiertas para siempre. Si se paga aunque sea una
          // parte, queda PENDING: esa parte hay que acordarla.
          ...(overage > 0
            ? {
                varianceResolution:
                  overagePaid === 0
                    ? ('ACCEPTED' as const)
                    : ('PENDING' as const),
                varianceNote:
                  dto.varianceNote?.trim() ||
                  (freeUnits > 0
                    ? `De ${overageHere} de más, ${overagePaid} se pagan y ${freeUnits} entraron sin costo por error del proveedor`
                    : null),
              }
            : {}),
          stockMovementId,
        },
        include: PURCHASE_INCLUDE,
      });
    }, this.txOptions);

    return this.toDto(item);
  }

  /**
   * "No llega más": cierra la línea con lo que haya llegado.
   *
   * ES LA ACCIÓN QUE CONVIERTE UN FALTANTE EN RECLAMO. Antes de cerrar, una
   * línea a la que le faltan unidades es un pedido en curso; después de cerrar,
   * es mercancía que el proveedor quedó debiendo. Sin este paso explícito, todo
   * pedido a medias parecería un reclamo desde el primer día.
   *
   * El faltante entra al libro con signo negativo —el proveedor pasa a deberme—
   * porque el pedido ya se le cargó completo cuando se confirmó. Si no se le
   * había pagado, el saldo simplemente vuelve a bajar y queda en cero: la resta
   * da lo mismo por los dos caminos.
   */
  async closeLine(ctx: TenantContext, id: string, note?: string) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status === 'RECEIVED') {
      throw new BadRequestException('Esta línea ya está cerrada');
    }
    if (current.status === 'CANCELLED') {
      throw new BadRequestException('El ítem está cancelado');
    }

    const receivedQuantity = current.receivedQuantity ?? 0;
    const shortage = Math.max(0, current.quantity - receivedQuantity);
    const unitCost =
      current.receivedUnitCostCOP ?? current.estimatedCostCOP ?? 0;

    const item = await this.prisma.$transaction(async (tx) => {
      if (shortage > 0 && current.supplierId) {
        await this.writeLedgerEntry(tx, ctx, {
          supplierId: current.supplierId,
          kind: 'SHORTAGE',
          // Negativo: el proveedor queda debiendo.
          amountCOP: -(shortage * unitCost),
          purchaseItemId: id,
          note: `Faltaron ${shortage} de "${current.name}"`,
        });
      }

      return tx.retailPurchaseItem.update({
        where: { id },
        data: {
          status: 'RECEIVED',
          receivedAt: current.receivedAt ?? new Date(),
          receivedById: current.receivedById ?? ctx.userId,
          orderedAt: current.orderedAt ?? new Date(),
          // Cerrar sin haber recibido nada es un faltante total, y eso es un 0,
          // no un "todavía no se sabe".
          receivedQuantity,
          ...(shortage > 0
            ? {
                varianceResolution: 'PENDING' as const,
                varianceNote: note?.trim() || current.varianceNote,
              }
            : {}),
        },
        include: PURCHASE_INCLUDE,
      });
    }, this.txOptions);

    return this.toDto(item);
  }

  /**
   * Cierra (o reabre) la cuenta que dejó un faltante o un sobrante.
   *
   * Es el paso que convierte "llegaron 12 de 24" en información accionable: la
   * diferencia sola no dice nada, lo que importa es si sigue abierta. Mientras
   * la línea esté en PENDING aparece como cuenta pendiente con ese proveedor;
   * REORDERED, CREDITED y ACCEPTED la cierran, cada una por un motivo distinto
   * que queda escrito en la nota.
   *
   * No mueve inventario ni finanzas: la reposición llega como un pedido nuevo y
   * la nota crédito entra como su propio movimiento de plata. Acá solo se
   * registra en qué quedó el reclamo.
   */
  async resolveVariance(
    ctx: TenantContext,
    id: string,
    dto: ResolveRetailPurchaseVarianceDto,
  ) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.receivedQuantity === null) {
      throw new BadRequestException(
        'Este pedido todavía no se ha recibido: no hay diferencia que resolver',
      );
    }
    if (current.receivedQuantity === current.quantity) {
      throw new BadRequestException(
        'Llegó completo: no hay diferencia que resolver',
      );
    }

    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: {
        varianceResolution: dto.resolution,
        // La nota se reemplaza y no se acumula: describe en qué QUEDÓ la
        // diferencia, y solo puede quedar en una cosa a la vez.
        varianceNote: dto.note?.trim() || current.varianceNote,
      },
      include: PURCHASE_INCLUDE,
    });
    return this.toDto(item);
  }

  /**
   * La ficha del proveedor a la que apunta un pedido.
   *
   * SE CREA SOLA A PARTIR DEL NOMBRE. Apuntar un pedido es lo que se hace de
   * afán, con el proveedor al teléfono; obligar a crear primero la ficha
   * convertiría un flujo de dos segundos en un formulario. La ficha se
   * enriquece después, cuando haga falta.
   *
   * La búsqueda es insensible a mayúsculas y a espacios de sobra, que es
   * exactamente el problema que la ficha viene a resolver: "crea con arte" y
   * "Crea con Arte" tienen que caer en la misma cuenta.
   */
  private async resolveSupplierId(
    ctx: TenantContext,
    dto: { supplierId?: string; supplier?: string },
  ): Promise<string | null> {
    if (dto.supplierId) return dto.supplierId;
    const name = dto.supplier?.trim();
    if (!name) return null;

    const existing = await this.prisma.retailSupplier.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: { equals: name, mode: 'insensitive' },
      },
      select: { id: true },
    });
    if (existing) return existing.id;

    const created = await this.prisma.retailSupplier.create({
      data: { tenantId: ctx.tenantId, branchId: ctx.branchId, name },
      select: { id: true },
    });
    return created.id;
  }

  /**
   * Escribe un movimiento en la cuenta corriente del proveedor.
   *
   * Silencioso cuando la línea no tiene proveedor enlazado: un pedido apuntado
   * sin proveedor es perfectamente válido —"pilas AA, donde sea"— y no tiene a
   * quién cargárselo. Inventar una ficha "Sin proveedor" para poder anotar ahí
   * juntaría en una sola cuenta a todos los que no se identificaron, que es
   * peor que no anotar.
   *
   * Monto 0 tampoco se escribe: una fila que no mueve el saldo solo hace ruido
   * en el extracto.
   */
  private async writeLedgerEntry(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    entry: {
      supplierId: string | null;
      kind: RetailSupplierLedgerKind;
      amountCOP: number;
      purchaseItemId?: string;
      expenseId?: string;
      note?: string;
      occurredAt?: Date;
    },
  ) {
    if (!entry.supplierId || entry.amountCOP === 0) return;
    await tx.retailSupplierLedgerEntry.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        supplierId: entry.supplierId,
        kind: entry.kind,
        amountCOP: entry.amountCOP,
        purchaseItemId: entry.purchaseItemId ?? null,
        expenseId: entry.expenseId ?? null,
        note: entry.note ?? null,
        occurredAt: entry.occurredAt ?? new Date(),
        userId: ctx.userId,
      },
    });
  }

  /** Ya no se va a pedir. Queda en la lista como registro, no se borra. */
  async cancel(ctx: TenantContext, id: string) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status === 'RECEIVED') {
      throw new BadRequestException(
        'El ítem ya llegó: para revertirlo, ajusta el inventario',
      );
    }
    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: { status: 'CANCELLED' },
      include: PURCHASE_INCLUDE,
    });
    return this.toDto(item);
  }

  /** Vuelve a "por pedir" un ítem cancelado. */
  async reopen(ctx: TenantContext, id: string) {
    const current = await this.assertOwnItem(ctx, id);
    if (current.status !== 'CANCELLED') {
      throw new BadRequestException('Solo se puede reabrir un ítem cancelado');
    }
    const item = await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: { status: 'PENDING', orderedAt: null, orderedById: null },
      include: PURCHASE_INCLUDE,
    });
    return this.toDto(item);
  }

  /** Soft-delete: sacar de la lista sin perder el histórico de lo recibido. */
  async remove(ctx: TenantContext, id: string) {
    await this.assertOwnItem(ctx, id);
    await this.prisma.retailPurchaseItem.update({
      where: { id },
      data: { deletedAt: new Date() },
    });
    return { ok: true };
  }

  private findWithProduct(id: string) {
    return this.prisma.retailPurchaseItem.findUniqueOrThrow({
      where: { id },
      include: PURCHASE_INCLUDE,
    });
  }

  private async assertOwnItem(
    ctx: TenantContext,
    id: string,
  ): Promise<RetailPurchaseItem> {
    await this.tenantHelper.assertRetailTenant(ctx.tenantId);
    const item = await this.prisma.retailPurchaseItem.findUnique({
      where: { id },
    });
    if (
      !item ||
      item.deletedAt ||
      item.tenantId !== ctx.tenantId ||
      item.branchId !== ctx.branchId
    ) {
      throw new NotFoundException(`Purchase item ${id} not found`);
    }
    return item;
  }

  private toDto(item: PurchaseWithRelations) {
    return {
      id: item.id,
      productId: item.productId,
      productName: item.product?.name ?? null,
      productSku: item.product?.sku ?? null,
      productStock: item.product?.stock ?? null,
      name: item.name,
      /** Lo PEDIDO. Ya no cambia al recibir. */
      quantity: item.quantity,
      /** Lo RECIBIDO. null = todavía no llega; 0 = llegó y no vino nada. */
      receivedQuantity: item.receivedQuantity,
      /**
       * Recibido − pedido. Negativo = el proveedor quedó debiendo, positivo =
       * mandó de más. null mientras no se haya recibido: sin las dos cifras la
       * resta no significa nada.
       */
      varianceQty:
        item.receivedQuantity === null
          ? null
          : item.receivedQuantity - item.quantity,
      varianceResolution: item.varianceResolution,
      varianceNote: item.varianceNote,
      unit: item.unit,
      supplier: item.supplier,
      estimatedCostCOP: item.estimatedCostCOP,
      receivedUnitCostCOP: item.receivedUnitCostCOP,
      // Lo que costaría la línea completa; el listado no debería multiplicar.
      //
      // Se mantiene `estimatedTotalCOP` con el nombre viejo y apuntando a lo
      // PEDIDO porque es de lo que cuelga el saldo con el proveedor en el
      // frontend. Antes se movía al recibir —cambiaba `quantity`, cambiaba este
      // número— y por eso un pedido pagado completo podía amanecer con deuda.
      estimatedTotalCOP:
        item.estimatedCostCOP !== null
          ? item.estimatedCostCOP * item.quantity
          : null,
      /**
       * Lo que realmente entró, a lo que realmente costó. Contra
       * `estimatedTotalCOP` da el saldo de MERCANCÍA con el proveedor, que es
       * distinto del saldo de plata y se salda distinto: uno con una reposición
       * o una nota crédito, el otro con un giro.
       */
      receivedTotalCOP:
        item.receivedQuantity !== null &&
        (item.receivedUnitCostCOP ?? item.estimatedCostCOP) !== null
          ? item.receivedQuantity *
            (item.receivedUnitCostCOP ?? item.estimatedCostCOP)!
          : null,
      note: item.note,
      status: item.status,
      isUrgent: item.isUrgent,
      createdAt: item.createdAt,
      orderedAt: item.orderedAt,
      receivedAt: item.receivedAt,
      createdById: item.createdById,
      orderedById: item.orderedById,
      receivedById: item.receivedById,
      // Deja ver si la entrada al inventario efectivamente se generó.
      stockMovementId: item.stockMovementId,
      // …y qué pagos quedaron registrados en Finanzas. Un pedido se paga en
      // varios giros, así que son listas; vacía = falta registrar el pago,
      // nunca "costó cero".
      expenseIds: item.expenseIds,
      shippingExpenseIds: item.shippingExpenseIds,
      /** La ficha del proveedor. `supplier` sigue siendo el nombre escrito. */
      supplierId: item.supplierId,
      supplierName: item.supplierRef?.name ?? item.supplier,
      /**
       * Cuántas unidades faltan por llegar. Distinto de `varianceQty`: esto es
       * lo que todavía puede llegar, aquello es lo que ya no va a llegar.
       * Mientras la línea no esté cerrada, no son la misma cosa.
       */
      remainingQuantity:
        item.status === 'RECEIVED'
          ? 0
          : Math.max(0, item.quantity - (item.receivedQuantity ?? 0)),
      /** Las tandas en que llegó, de la más vieja a la más nueva. */
      receipts: item.receipts.map((receipt) => ({
        id: receipt.id,
        quantity: receipt.quantity,
        unitCostCOP: receipt.unitCostCOP,
        reference: receipt.reference,
        note: receipt.note,
        stockMovementId: receipt.stockMovementId,
        receivedAt: receipt.receivedAt,
      })),
    };
  }

  private readonly txOptions = { timeout: 15_000 };
}
