import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { CashMovementType, OrderEventType, Prisma } from '@prisma/client';
import { performance } from 'perf_hooks';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateOrderDto } from './dto/create-order.dto';
import { AddItemsDto } from './dto/add-items.dto';
import { CloseOrderDto } from './dto/close-order.dto';
import { RegisterPaymentDto } from './dto/payment.dto';
import { VoidOrderDto } from './dto/void-order.dto';
import {
  KITCHEN_TICKET_UPDATED,
  KitchenTicketUpdatedEvent,
  ORDER_CLOSED,
  OrderClosedEvent,
  TABLE_UPDATED,
  TableUpdatedEvent,
} from '../../../realtime/realtime.events';
import { OrderEventsService } from '../order-events/order-events.service';
import { PrintJobsService } from '../printing/print-jobs.service';
import { PrintingDocumentService } from '../printing/printing-document.service';
import { ReceiptsService } from '../receipts/receipts.service';
import { NotificationDispatcherService } from '../../../notifications/notification-dispatcher.service';
import { RequestMetricsStore } from '../../../monitoring/request-metrics.store';
import { convertQuantity as convertUnitQuantity } from '../inventory/unit-conversion';

// Opciones para las transacciones interactivas de órdenes. El default de
// Prisma es timeout 5s / maxWait 2s, que se queda corto cuando la DB está
// lejos (cada query es un round-trip de ~200ms) y la tx hace varias queries
// → P2028 "Transaction not found". Damos holgura sin colgar indefinidamente.
const ORDER_TX_OPTIONS = { maxWait: 10_000, timeout: 20_000 } as const;

const ORDER_INCLUDE = {
  items: {
    include: { product: { select: { id: true, name: true, priceCOP: true } } },
  },
  kitchenTickets: { include: { items: true } },
  paymentSplits: { include: { contributions: true, items: true } },
} as const;

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
    private readonly orderEvents: OrderEventsService,
    private readonly printJobs: PrintJobsService,
    private readonly printingDocs: PrintingDocumentService,
    private readonly receipts: ReceiptsService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  async findAll(ctx: TenantContext, status = 'OPEN', tableId?: string) {
    const orders = await this.prisma.order.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status,
        ...(tableId ? { tableId } : {}),
      },
      include: ORDER_INCLUDE,
      orderBy: { createdAt: 'desc' },
    });

    return { orders: orders.map(this.mapOrder) };
  }

  async findOne(ctx: TenantContext, id: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId: ctx.tenantId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    return this.mapOrder(order);
  }

  async create(ctx: TenantContext, dto: CreateOrderDto) {
    const items = dto.items ?? [];
    const table = await this.prisma.restaurantTable.findFirst({
      where: {
        id: dto.tableId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
    });
    if (!table) throw new NotFoundException(`Table ${dto.tableId} not found`);

    // Idempotencia por mesa: si ya hay una orden OPEN, REUSARLA en vez de crear
    // una segunda. Evita órdenes duplicadas por carreras del cliente o estados
    // inconsistentes (la mesa veía una orden y el otro cliente otra → "duplicado").
    const existingOpen = await this.prisma.order.findFirst({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        tableId: dto.tableId,
        status: 'OPEN',
      },
      select: { id: true },
    });
    if (existingOpen) {
      if (items.length > 0) {
        return this.addItems(ctx, existingOpen.id, { items });
      }
      return this.findOne(ctx, existingOpen.id);
    }

    // No hay orden abierta: solo bloquea si la mesa está fuera de juego.
    if (table.status === 'RESERVED' || table.status === 'CLOSED')
      throw new ConflictException(
        `Table is not available (status: ${table.status})`,
      );

    const productIds = items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        tenantId: ctx.tenantId,
        deletedAt: null,
      },
    });
    if (products.length !== productIds.length)
      throw new NotFoundException('One or more products not found');

    const productMap = new Map(products.map((p) => [p.id, p]));

    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          tableId: dto.tableId,
          terminalId: dto.terminalId,
          waiterId: dto.waiterId,
          status: 'OPEN',
          items:
            items.length > 0
              ? {
                  create: items.map((i) => ({
                    productId: i.productId,
                    name: productMap.get(i.productId)!.name,
                    priceCOP: productMap.get(i.productId)!.priceCOP,
                    qty: i.qty,
                    sentQty: 0,
                  })),
                }
              : undefined,
        },
        include: ORDER_INCLUDE,
      });

      await tx.restaurantTable.update({
        where: { id: dto.tableId },
        data: { status: 'PREPARING' },
      });

      // Un solo `createMany` (OPENED + un ITEM_ADDED por ítem) en lugar de
      // N inserts en serie: evita multiplicar la latencia dentro de la tx.
      await this.orderEvents.recordMany(
        [
          {
            tenantId: ctx.tenantId,
            orderId: newOrder.id,
            type: OrderEventType.OPENED,
            metadata: {
              tableId: dto.tableId,
              terminalId: dto.terminalId ?? null,
              waiterId: dto.waiterId ?? null,
            },
          },
          ...items.map((item) => {
            const product = productMap.get(item.productId)!;
            return {
              tenantId: ctx.tenantId,
              orderId: newOrder.id,
              type: OrderEventType.ITEM_ADDED,
              metadata: {
                productId: item.productId,
                name: product.name,
                priceCOP: product.priceCOP,
                previousQty: 0,
                newQty: item.qty,
                deltaQty: item.qty,
              },
            };
          }),
        ],
        tx,
      );

      return newOrder;
    }, ORDER_TX_OPTIONS);

    this.events.emit(TABLE_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      tableId: dto.tableId,
      reason: 'order-opened',
    } satisfies TableUpdatedEvent);

    return this.mapOrder(order);
  }

  async addItems(ctx: TenantContext, id: string, dto: AddItemsDto) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: {
        id: { in: productIds },
        tenantId: ctx.tenantId,
        deletedAt: null,
      },
    });
    if (products.length !== productIds.length)
      throw new NotFoundException('One or more products not found');

    const productMap = new Map(products.map((p) => [p.id, p]));
    // Semántica aditiva/merge: el payload agrega ítems nuevos y actualiza la
    // cantidad de los que ya existen. Los ítems de la orden que NO vengan en
    // el payload se dejan intactos (no se eliminan). Las eliminaciones, si se
    // necesitan, van por un endpoint aparte.
    const changedItems = dto.items
      .map((item) => ({
        desired: item,
        existing: order.items.find((i) => i.productId === item.productId),
      }))
      .filter(
        (entry) => entry.existing && entry.existing.qty !== entry.desired.qty,
      );
    const addedItems = dto.items.filter(
      (item) =>
        !order.items.some((existing) => existing.productId === item.productId),
    );

    for (const item of dto.items) {
      const existing = order.items.find((i) => i.productId === item.productId);
      if (existing && item.qty < existing.sentQty) {
        throw new UnprocessableEntityException(
          `Cannot reduce ${existing.name} below sent quantity (${existing.sentQty})`,
        );
      }
    }

    await this.prisma.$transaction(async (tx) => {
      // Ítems nuevos en un solo insert.
      if (addedItems.length > 0) {
        await tx.orderItem.createMany({
          data: addedItems.map((item) => ({
            orderId: id,
            productId: item.productId,
            name: productMap.get(item.productId)!.name,
            priceCOP: productMap.get(item.productId)!.priceCOP,
            qty: item.qty,
            sentQty: 0,
          })),
        });
      }

      // Solo actualizamos los ítems cuya cantidad realmente cambió.
      for (const entry of changedItems) {
        await tx.orderItem.update({
          where: { id: entry.existing!.id },
          data: { qty: entry.desired.qty },
        });
      }

      await this.orderEvents.ensureOpened(ctx.tenantId, id, order.createdAt, tx);

      // Eventos (added/updated) en un solo createMany.
      await this.orderEvents.recordMany(
        [
          ...addedItems.map((item) => {
            const product = productMap.get(item.productId)!;
            return {
              tenantId: ctx.tenantId,
              orderId: id,
              type: OrderEventType.ITEM_ADDED,
              metadata: {
                productId: item.productId,
                name: product.name,
                priceCOP: product.priceCOP,
                previousQty: 0,
                newQty: item.qty,
                deltaQty: item.qty,
              },
            };
          }),
          ...changedItems.map((entry) => {
            const existing = entry.existing!;
            return {
              tenantId: ctx.tenantId,
              orderId: id,
              type: OrderEventType.ITEM_UPDATED,
              metadata: {
                productId: existing.productId,
                name: existing.name,
                priceCOP: existing.priceCOP,
                previousQty: existing.qty,
                newQty: entry.desired.qty,
                deltaQty: entry.desired.qty - existing.qty,
                sentQty: existing.sentQty,
              },
            };
          }),
        ],
        tx,
      );
    }, ORDER_TX_OPTIONS);

    return this.findOne(ctx, id);
  }

  async sendToKitchen(ctx: TenantContext, id: string) {
    const assertStart = performance.now();
    const order = await this.assertOpenOrder(id, ctx.tenantId);
    RequestMetricsStore.recordTiming(
      'orders.sendToKitchen.assertOpenOrder',
      performance.now() - assertStart,
    );

    const pendingItems = order.items.filter((i) => i.qty > i.sentQty);
    if (pendingItems.length === 0)
      throw new UnprocessableEntityException(
        'No pending items to send to kitchen',
      );

    const txStart = performance.now();
    const ticket = await this.prisma.$transaction(async (tx) => {
      const newTicket = await tx.kitchenTicket.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: id,
          status: 'PENDING',
          sentAt: new Date(),
          items: {
            create: pendingItems.map((i) => ({
              productId: i.productId,
              name: i.name,
              qty: i.qty - i.sentQty,
            })),
          },
        },
        include: { items: true },
      });

      // Una sola query para TODAS las recetas de los productos pendientes
      // (antes era un findMany por ítem → N round-trips a la DB).
      const pendingProductIds = [
        ...new Set(pendingItems.map((i) => i.productId)),
      ];
      const recipeLines = await tx.recipeLine.findMany({
        where: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          productId: { in: pendingProductIds },
        },
        include: { ingredient: true },
      });
      const linesByProduct = new Map<string, typeof recipeLines>();
      for (const line of recipeLines) {
        const arr = linesByProduct.get(line.productId);
        if (arr) arr.push(line);
        else linesByProduct.set(line.productId, [line]);
      }

      // Cálculo del consumo de stock en memoria (sin tocar la DB). Los saldos
      // se encadenan por ingrediente igual que antes; las escrituras se hacen
      // en lote al final.
      const stockBalances = new Map<string, number>();
      const ingredientById = new Map<
        string,
        (typeof recipeLines)[number]['ingredient']
      >();
      const movements: Prisma.StockMovementCreateManyInput[] = [];

      for (const item of pendingItems) {
        const itemQty = item.qty - item.sentQty;
        for (const line of linesByProduct.get(item.productId) ?? []) {
          ingredientById.set(line.ingredientId, line.ingredient);

          const netRequiredInRecipeUnit = convertUnitQuantity(
            line.quantity * itemQty,
            line.unit,
            line.ingredient.recipeUnit,
            line.ingredient,
          );
          const usableRatio =
            1 - line.ingredient.technicalWastePercentage / 100;
          if (usableRatio <= 0) {
            throw new UnprocessableEntityException(
              `Invalid waste percentage for ingredient ${line.ingredient.name}`,
            );
          }

          const grossRequiredInRecipeUnit =
            netRequiredInRecipeUnit / usableRatio;
          const grossRequiredInPurchaseUnit = convertUnitQuantity(
            grossRequiredInRecipeUnit,
            line.ingredient.recipeUnit,
            line.ingredient.purchaseUnit,
            line.ingredient,
          );
          const previousStock =
            stockBalances.get(line.ingredientId) ??
            line.ingredient.currentStock;
          const newStock = previousStock - grossRequiredInPurchaseUnit;

          if (newStock < 0) {
            const round = (n: number) => Math.round(n * 10000) / 10000;
            const grossPerUnit = grossRequiredInPurchaseUnit / itemQty;
            const maxPreparables =
              grossPerUnit > 0 ? Math.floor(previousStock / grossPerUnit) : 0;
            throw new UnprocessableEntityException({
              statusCode: 422,
              error: 'Unprocessable Entity',
              message: `Insufficient stock for ingredient ${line.ingredient.name}`,
              stock: {
                ingredientId: line.ingredientId,
                ingredientName: line.ingredient.name,
                available: round(previousStock),
                requested: round(grossRequiredInPurchaseUnit),
                unit: line.ingredient.purchaseUnit,
                maxPreparables,
              },
            });
          }

          stockBalances.set(line.ingredientId, newStock);
          movements.push({
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            ingredientId: line.ingredientId,
            type: 'CONSUMPTION',
            quantity: -grossRequiredInPurchaseUnit,
            previousStock,
            newStock,
            orderId: id,
            notes: `Auto consumption for ${item.name}`,
            createdBy: ctx.userId,
            createdByName: ctx.name,
          });
        }
      }

      // Movimientos de stock en un solo insert.
      if (movements.length > 0) {
        await tx.stockMovement.createMany({ data: movements });
      }

      // Un update por ingrediente distinto con su saldo final.
      for (const [ingredientId, newStock] of stockBalances) {
        const ingredient = ingredientById.get(ingredientId)!;
        const usableRatio = 1 - ingredient.technicalWastePercentage / 100;
        const netUsableQuantity =
          convertUnitQuantity(
            newStock,
            ingredient.purchaseUnit,
            ingredient.recipeUnit,
            ingredient,
          ) * usableRatio;

        await tx.ingredient.update({
          where: { id: ingredientId },
          data: {
            currentStock: newStock,
            grossStockQuantity: newStock,
            netUsableQuantity,
            netUnitCost:
              netUsableQuantity > 0
                ? ingredient.totalPurchaseCost / netUsableQuantity
                : 0,
          },
        });
      }

      // Marcar como enviados los ítems pendientes.
      for (const item of pendingItems) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { sentQty: item.qty },
        });
      }

      await this.orderEvents.record(
        {
          tenantId: ctx.tenantId,
          orderId: id,
          type: OrderEventType.SENT_TO_KITCHEN,
          ticketId: newTicket.id,
          metadata: {
            ticketId: newTicket.id,
            items: pendingItems.map((item) => ({
              productId: item.productId,
              name: item.name,
              qty: item.qty - item.sentQty,
              previousSentQty: item.sentQty,
              newSentQty: item.qty,
            })),
          },
        },
        tx,
      );

      return newTicket;
    }, ORDER_TX_OPTIONS);
    RequestMetricsStore.recordTiming(
      'orders.sendToKitchen.transaction',
      performance.now() - txStart,
    );

    // Comanda a cocina (best-effort: la impresión nunca bloquea el flujo).
    const printStart = performance.now();
    await this.emitKitchenTicketPrint(ctx, order.tableId, ticket);
    RequestMetricsStore.recordTiming(
      'orders.sendToKitchen.print',
      performance.now() - printStart,
    );

    this.events.emit(KITCHEN_TICKET_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      ticket: {
        id: ticket.id,
        orderId: ticket.orderId,
        tableId: order.tableId,
        status: ticket.status,
        priority: ticket.priority,
        sentAt: ticket.sentAt.getTime(),
        readyAt: ticket.readyAt?.getTime() ?? null,
        servedAt: ticket.servedAt?.getTime() ?? null,
        items: ticket.items.map((i) => ({
          id: i.id,
          productId: i.productId,
          name: i.name,
          qty: i.qty,
        })),
      },
    } satisfies KitchenTicketUpdatedEvent);

    // Push por rol a cocina (best-effort: nunca bloquea el flujo del POS).
    const itemCount = ticket.items.reduce((sum, i) => sum + i.qty, 0);
    void this.notifications
      .dispatch({
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        vertical: 'restaurant',
        type: 'order.kitchen.new',
        title: 'Nueva comanda',
        body: `${itemCount} ${itemCount === 1 ? 'ítem enviado' : 'ítems enviados'} a cocina.`,
        url: '/kitchen',
        payload: { orderId: id, ticketId: ticket.id },
        excludeUserId: ctx.userId,
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Kitchen notification dispatch failed: ${message}`);
      });

    return ticket;
  }

  async requestPayment(ctx: TenantContext, id: string, dto: RegisterPaymentDto) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);
    const totalContributions = dto.contributions.reduce(
      (sum, c) => sum + c.amount,
      0,
    );
    if (totalContributions !== dto.totalCOP) {
      throw new UnprocessableEntityException(
        'Payment contributions must equal totalCOP',
      );
    }
    const totalItems = dto.items.reduce(
      (sum, item) => sum + item.priceCOP * item.qty,
      0,
    );
    if (totalItems !== dto.totalCOP) {
      throw new UnprocessableEntityException(
        'Payment items total must equal totalCOP',
      );
    }

    const contributions = this.normalizePaymentContributions(dto.contributions);
    const items = this.normalizePaymentItems(dto.items);

    await this.prisma.$transaction(async (tx) => {
      await tx.paymentSplit.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: id,
          totalCOP: dto.totalCOP,
          contributions: {
            create: contributions,
          },
          items: {
            create: items,
          },
        },
      });

      await tx.restaurantTable.update({
        where: { id: order.tableId },
        data: { status: 'PAYMENT' },
      });

      await this.orderEvents.record(
        {
          tenantId: ctx.tenantId,
          orderId: id,
          type: OrderEventType.PAYMENT_REQUESTED,
          metadata: {
            totalCOP: dto.totalCOP,
            contributions,
          },
        },
        tx,
      );
      await this.orderEvents.record(
        {
          tenantId: ctx.tenantId,
          orderId: id,
          type: OrderEventType.PAYMENT_REGISTERED,
          metadata: {
            totalCOP: dto.totalCOP,
            contributions,
            items,
          },
        },
        tx,
      );
    }, ORDER_TX_OPTIONS);

    this.events.emit(TABLE_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      tableId: order.tableId,
      reason: 'payment-requested',
    } satisfies TableUpdatedEvent);

    return this.findOne(ctx, id);
  }

  async close(ctx: TenantContext, id: string, dto: CloseOrderDto) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);
    const paymentSplits = await this.prisma.paymentSplit.findMany({
      where: { orderId: id, tenantId: ctx.tenantId },
      include: { contributions: true, items: true },
      orderBy: { paidAt: 'asc' },
    });
    if (paymentSplits.length === 0) {
      throw new UnprocessableEntityException(
        'Order must have at least one payment split before close',
      );
    }

    const totalCOP = paymentSplits.reduce((sum, ps) => sum + ps.totalCOP, 0);
    const orderTotalCOP = order.items.reduce(
      (sum, item) => sum + item.priceCOP * item.qty,
      0,
    );
    if (totalCOP !== orderTotalCOP) {
      throw new UnprocessableEntityException(
        'Registered payments must equal order total before close',
      );
    }
    const terminalId = dto.terminalId ?? order.terminalId;

    const closedAt = new Date();
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closedAt,
          totalCOP,
          terminalId,
        },
      });

      await tx.restaurantTable.update({
        where: { id: order.tableId },
        data: { status: 'AVAILABLE' },
      });

      await this.orderEvents.record(
        {
          tenantId: ctx.tenantId,
          orderId: id,
          type: OrderEventType.CLOSED,
          at: closedAt,
          metadata: {
            totalCOP,
            terminalId: terminalId ?? null,
            cashSessionId: dto.cashSessionId ?? null,
            paymentSplitIds: paymentSplits.map((split) => split.id),
          },
        },
        tx,
      );
    }, ORDER_TX_OPTIONS);

    // ── Post-cierre (best-effort: no debe romper la venta) ──────────────────
    // 1) Movimiento de caja SALE (si hay sesión abierta para el terminal).
    let cashSessionId: string | null = null;
    try {
      cashSessionId = await this.recordCashSale(
        ctx,
        terminalId,
        dto.cashSessionId,
        paymentSplits.flatMap((split) =>
          split.contributions.map((c) => ({
            method: c.method,
            amount: c.amount,
          })),
        ),
        id,
      );
    } catch {
      cashSessionId = null;
    }

    // 2) Recibo compartible + PrintJob RECEIPT.
    let receiptUrl: string | null = null;
    try {
      const fullOrder = await this.prisma.order.findUnique({
        where: { id },
        include: {
          items: true,
          table: { select: { code: true } },
          waiter: { select: { name: true } },
          tenant: { select: { name: true } },
          paymentSplits: { include: { contributions: true, items: true } },
        },
      });
      if (fullOrder) {
        const receipt = await this.receipts.createForOrder(fullOrder);
        receiptUrl = receipt.url;
        await this.printJobs.enqueue({
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          createdByUserId: ctx.userId,
          document: receipt.document,
        });
      }
    } catch {
      // El front puede recuperar el recibo vía /sales/:id o /receipts/share.
    }

    this.events.emit(ORDER_CLOSED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      orderId: id,
      tableId: order.tableId,
      totalCOP,
    } satisfies OrderClosedEvent);

    this.events.emit(TABLE_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      tableId: order.tableId,
      reason: 'order-closed',
    } satisfies TableUpdatedEvent);

    return {
      id,
      status: 'CLOSED',
      paymentSplits,
      cashSessionId,
      receiptUrl,
    };
  }

  async voidOrder(ctx: TenantContext, id: string, dto: VoidOrderDto) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);
    const paymentCount = await this.prisma.paymentSplit.count({
      where: { orderId: id, tenantId: ctx.tenantId },
    });
    if (paymentCount > 0) {
      throw new UnprocessableEntityException(
        'Cannot void an order with registered payments',
      );
    }

    const voidedAt = new Date();
    const voidType = dto.voidType ?? 'other';
    await this.prisma.$transaction(async (tx) => {
      await tx.order.update({
        where: { id },
        data: {
          status: 'VOIDED',
          closedAt: voidedAt,
          totalCOP: 0,
        },
      });

      await tx.restaurantTable.update({
        where: { id: order.tableId },
        data: { status: 'AVAILABLE' },
      });

      await this.orderEvents.record(
        {
          tenantId: ctx.tenantId,
          orderId: id,
          type: 'VOIDED' as OrderEventType,
          at: voidedAt,
          note: dto.reason,
          metadata: {
            voidType,
            byUserId: ctx.userId ?? null,
            byUserName: dto.byUserName ?? null,
            originalTotalCOP: order.items.reduce(
              (sum, item) => sum + item.priceCOP * item.qty,
              0,
            ),
            items: order.items.map((item) => ({
              productId: item.productId,
              name: item.name,
              qty: item.qty,
              priceCOP: item.priceCOP,
            })),
          },
        },
        tx,
      );

      if (voidType === 'claim') {
        await tx.orderClaim.create({
          data: {
            tenantId: ctx.tenantId,
            orderId: id,
            description: dto.reason,
            severity: 'MEDIUM',
            byUserId: ctx.userId ?? null,
            byUserName: dto.byUserName ?? null,
          },
        });
      }
    }, ORDER_TX_OPTIONS);

    this.events.emit(TABLE_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      tableId: order.tableId,
      reason: 'order-voided',
    } satisfies TableUpdatedEvent);

    return {
      id,
      status: 'VOIDED',
      voidType,
      reason: dto.reason,
      affectsFinance: false,
      affectsCash: false,
    };
  }

  private normalizePaymentContributions(
    contributions: RegisterPaymentDto['contributions'],
  ) {
    const byMethod = new Map<
      string,
      { method: string; amount: number; cardType: string | null }
    >();
    for (const contribution of contributions) {
      const existing = byMethod.get(contribution.method);
      if (existing) {
        existing.amount += contribution.amount;
        existing.cardType ??= contribution.cardType ?? null;
      } else {
        byMethod.set(contribution.method, {
          method: contribution.method,
          amount: contribution.amount,
          cardType: contribution.cardType ?? null,
        });
      }
    }
    return [...byMethod.values()];
  }

  private normalizePaymentItems(items: RegisterPaymentDto['items']) {
    const byProduct = new Map<
      string,
      { productId: string; name: string; qty: number; priceCOP: number }
    >();
    for (const item of items) {
      const existing = byProduct.get(item.productId);
      if (existing) {
        existing.qty += item.qty;
      } else {
        byProduct.set(item.productId, { ...item });
      }
    }
    return [...byProduct.values()];
  }

  private async recordCashSale(
    ctx: TenantContext,
    terminalId: string | null | undefined,
    cashSessionId: string | null | undefined,
    contributions: Array<{ method: string; amount: number }>,
    orderId: string,
  ) {
    const session = cashSessionId
      ? await this.prisma.cashSession.findFirst({
          where: {
            id: cashSessionId,
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            status: 'OPEN',
          },
        })
      : await this.prisma.cashSession.findFirst({
          where: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            status: 'OPEN',
            ...(terminalId ? { terminalId } : {}),
          },
          orderBy: { openedAt: 'desc' },
        });

    if (!session) return null;

    await this.prisma.cashMovement.createMany({
      data: contributions.map((c) => ({
        sessionId: session.id,
        type: CashMovementType.SALE,
        method: c.method,
        amount: c.amount,
        reference: orderId,
        createdByUserId: ctx.userId,
      })),
    });
    return session.id;
  }

  /** Comanda de cocina best-effort: nunca propaga errores al flujo de orden. */
  private async emitKitchenTicketPrint(
    ctx: TenantContext,
    tableId: string,
    ticket: { id: string; orderId: string; sentAt: Date; priority: string; items: Array<{ name: string; qty: number }> },
  ) {
    try {
      const table = await this.prisma.restaurantTable.findUnique({
        where: { id: tableId },
        select: { code: true },
      });
      const document = this.printingDocs.buildKitchenTicket({
        ticketId: ticket.id,
        orderId: ticket.orderId,
        tableCode: table?.code ?? null,
        priority: ticket.priority,
        sentAt: ticket.sentAt,
        items: ticket.items.map((i) => ({ name: i.name, qty: i.qty })),
      });
      await this.printJobs.enqueue({
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        createdByUserId: ctx.userId,
        document,
      });
    } catch {
      // sin impresora / error de driver → el front usa preview.
    }
  }

  private async assertOpenOrder(id: string, tenantId: string) {
    const order = await this.prisma.order.findFirst({
      where: { id, tenantId },
      include: { items: true },
    });
    if (!order) throw new NotFoundException(`Order ${id} not found`);
    if (order.status !== 'OPEN')
      throw new UnprocessableEntityException('Order is not open');
    return order;
  }

  private mapOrder(order: any) {
    return {
      ...order,
      createdAt: order.createdAt.getTime(),
      closedAt: order.closedAt?.getTime() ?? null,
      totalCOP: order.items?.reduce(
        (sum: number, i: any) => sum + i.priceCOP * i.qty,
        0,
      ),
      kitchenTickets: order.kitchenTickets?.map((kt: any) => ({
        ...kt,
        sentAt: kt.sentAt.getTime(),
        readyAt: kt.readyAt?.getTime() ?? null,
        servedAt: kt.servedAt?.getTime() ?? null,
      })),
      paymentSplits: order.paymentSplits?.map((ps: any) => ({
        ...ps,
        paidAt: ps.paidAt.getTime(),
      })),
    };
  }

}
