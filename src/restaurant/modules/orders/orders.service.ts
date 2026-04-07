import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { CreateOrderDto } from './dto/create-order.dto';
import { AddItemsDto } from './dto/add-items.dto';
import { CloseOrderDto } from './dto/close-order.dto';

const ORDER_INCLUDE = {
  items: {
    include: { product: { select: { id: true, name: true, priceCOP: true } } },
  },
  kitchenTickets: { include: { items: true } },
  paymentSplits: { include: { contributions: true, items: true } },
} as const;

@Injectable()
export class OrdersService {
  constructor(private readonly prisma: PrismaService) {}

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
      where: { id: dto.tableId, tenantId: ctx.tenantId, branchId: ctx.branchId },
    });
    if (!table) throw new NotFoundException(`Table ${dto.tableId} not found`);
    if (table.status !== 'AVAILABLE')
      throw new ConflictException(`Table is not available (status: ${table.status})`);

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: ctx.tenantId, deletedAt: null },
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

    return this.mapOrder(order);
  }

  async addItems(ctx: TenantContext, id: string, dto: AddItemsDto) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);

    const productIds = dto.items.map((i) => i.productId);
    const products = await this.prisma.product.findMany({
      where: { id: { in: productIds }, tenantId: ctx.tenantId, deletedAt: null },
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
      throw new UnprocessableEntityException('No pending items to send to kitchen');

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

      for (const item of pendingItems) {
        await tx.orderItem.update({
          where: { id: item.id },
          data: { sentQty: item.qty },
        });
      }

      return newTicket;
    });

    return ticket;
  }

  async requestPayment(ctx: TenantContext, id: string) {
    const order = await this.assertOpenOrder(id, ctx.tenantId);

    await this.prisma.restaurantTable.update({
      where: { id: order.tableId },
      data: { status: 'PAYMENT' },
    });

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
        data: { status: 'CLOSED', closedAt: new Date(), totalCOP: dto.totalCOP },
      });

      await tx.restaurantTable.update({
        where: { id: order.tableId },
        data: { status: 'AVAILABLE' },
      });

      return paymentSplit;
    });

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
}
