import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateOrderDto } from './dto/create-order.dto';
import { AddItemsDto } from './dto/add-items.dto';
import { CloseOrderDto } from './dto/close-order.dto';
import {
  KITCHEN_TICKET_UPDATED,
  KitchenTicketUpdatedEvent,
  ORDER_CLOSED,
  OrderClosedEvent,
  TABLE_UPDATED,
  TableUpdatedEvent,
} from '../../../realtime/realtime.events';

const ORDER_INCLUDE = {
  items: {
    include: { product: { select: { id: true, name: true, priceCOP: true } } },
  },
  kitchenTickets: { include: { items: true } },
  paymentSplits: { include: { contributions: true, items: true } },
} as const;

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly events: EventEmitter2,
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
    const table = await this.prisma.restaurantTable.findFirst({
      where: {
        id: dto.tableId,
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
    });
    if (!table) throw new NotFoundException(`Table ${dto.tableId} not found`);
    if (table.status !== 'AVAILABLE')
      throw new ConflictException(
        `Table is not available (status: ${table.status})`,
      );

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

    const order = await this.prisma.$transaction(async (tx) => {
      const newOrder = await tx.order.create({
        data: {
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          tableId: dto.tableId,
          waiterId: dto.waiterId,
          status: 'OPEN',
          items: {
            create: dto.items.map((i) => ({
              productId: i.productId,
              name: productMap.get(i.productId)!.name,
              priceCOP: productMap.get(i.productId)!.priceCOP,
              qty: i.qty,
              sentQty: 0,
            })),
          },
        },
        include: ORDER_INCLUDE,
      });

      await tx.restaurantTable.update({
        where: { id: dto.tableId },
        data: { status: 'PREPARING' },
      });

      return newOrder;
    });

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

    for (const item of dto.items) {
      const existing = order.items.find((i) => i.productId === item.productId);
      if (existing) {
        await this.prisma.orderItem.update({
          where: { id: existing.id },
          data: { qty: existing.qty + item.qty },
        });
      } else {
        await this.prisma.orderItem.create({
          data: {
            orderId: id,
            productId: item.productId,
            name: productMap.get(item.productId)!.name,
            priceCOP: productMap.get(item.productId)!.priceCOP,
            qty: item.qty,
            sentQty: 0,
          },
        });
      }
    }

    return this.findOne(ctx, id);
  }

  async sendToKitchen(ctx: TenantContext, id: string) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);

    const pendingItems = order.items.filter((i) => i.qty > i.sentQty);
    if (pendingItems.length === 0)
      throw new UnprocessableEntityException(
        'No pending items to send to kitchen',
      );

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

      const stockBalances = new Map<string, number>();

      for (const item of pendingItems) {
        const itemQty = item.qty - item.sentQty;
        const recipeLines = await tx.recipeLine.findMany({
          where: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            productId: item.productId,
          },
          include: { ingredient: true },
        });

        for (const line of recipeLines) {
          const netRequiredInRecipeUnit = this.convertQuantity(
            line.quantity * itemQty,
            line.unit,
            line.ingredient.recipeUnit,
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
          const grossRequiredInPurchaseUnit = this.convertQuantity(
            grossRequiredInRecipeUnit,
            line.ingredient.recipeUnit,
            line.ingredient.purchaseUnit,
          );
          const previousStock =
            stockBalances.get(line.ingredientId) ??
            line.ingredient.currentStock;
          const newStock = previousStock - grossRequiredInPurchaseUnit;

          if (newStock < 0) {
            throw new UnprocessableEntityException(
              `Insufficient stock for ingredient ${line.ingredient.name}`,
            );
          }

          stockBalances.set(line.ingredientId, newStock);

          await tx.stockMovement.create({
            data: {
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
            },
          });

          const netUsableQuantity =
            this.convertQuantity(
              newStock,
              line.ingredient.purchaseUnit,
              line.ingredient.recipeUnit,
            ) * usableRatio;

          await tx.ingredient.update({
            where: { id: line.ingredientId },
            data: {
              currentStock: newStock,
              grossStockQuantity: newStock,
              netUsableQuantity,
              netUnitCost:
                netUsableQuantity > 0
                  ? line.ingredient.totalPurchaseCost / netUsableQuantity
                  : 0,
            },
          });
        }

        await tx.orderItem.update({
          where: { id: item.id },
          data: { sentQty: item.qty },
        });
      }

      return newTicket;
    });

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

    return ticket;
  }

  async requestPayment(ctx: TenantContext, id: string) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);

    await this.prisma.restaurantTable.update({
      where: { id: order.tableId },
      data: { status: 'PAYMENT' },
    });

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

    const closed = await this.prisma.$transaction(async (tx) => {
      const paymentSplit = await tx.paymentSplit.create({
        data: {
          tenantId: ctx.tenantId,
          orderId: id,
          totalCOP: dto.totalCOP,
          contributions: {
            create: [
              {
                method: dto.paymentMethod,
                amount: dto.totalCOP,
                cardType: dto.cardType,
              },
            ],
          },
        },
        include: { contributions: true },
      });

      await tx.order.update({
        where: { id },
        data: {
          status: 'CLOSED',
          closedAt: new Date(),
          totalCOP: dto.totalCOP,
        },
      });

      await tx.restaurantTable.update({
        where: { id: order.tableId },
        data: { status: 'AVAILABLE' },
      });

      return paymentSplit;
    });

    this.events.emit(ORDER_CLOSED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      orderId: id,
      tableId: order.tableId,
      totalCOP: dto.totalCOP,
    } satisfies OrderClosedEvent);

    this.events.emit(TABLE_UPDATED, {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      tableId: order.tableId,
      reason: 'order-closed',
    } satisfies TableUpdatedEvent);

    return { id, status: 'CLOSED', paymentSplits: [closed] };
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

  private convertQuantity(quantity: number, from: string, to: string) {
    if (from === to) return quantity;

    const gramsPerUnit: Record<string, number> = {
      g: 1,
      kg: 1000,
      lb: 453.59237,
    };
    const mlPerUnit: Record<string, number> = { ml: 1, L: 1000 };

    if (from in gramsPerUnit && to in gramsPerUnit) {
      return (quantity * gramsPerUnit[from]) / gramsPerUnit[to];
    }

    if (from in mlPerUnit && to in mlPerUnit) {
      return (quantity * mlPerUnit[from]) / mlPerUnit[to];
    }

    throw new UnprocessableEntityException(
      `Incompatible units: ${from} -> ${to}`,
    );
  }
}
