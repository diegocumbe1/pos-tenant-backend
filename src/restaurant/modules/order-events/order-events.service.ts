import { Injectable } from '@nestjs/common';
import { OrderEventType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

type TxClient = Prisma.TransactionClient | PrismaService;

export interface RecordEventInput {
  tenantId: string;
  orderId: string;
  type: OrderEventType;
  ticketId?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue;
  at?: Date;
}

/**
 * Escribe la bitácora (`OrderEvent`) de las órdenes. Lo usan los módulos
 * `orders` y `kitchen` para alimentar la línea de tiempo y los tiempos de venta.
 */
@Injectable()
export class OrderEventsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Registra un evento. Acepta un cliente de transacción opcional para
   * escribir dentro de una transacción ya abierta.
   */
  async record(input: RecordEventInput, tx?: TxClient) {
    const client = tx ?? this.prisma;
    return client.orderEvent.create({
      data: {
        tenantId: input.tenantId,
        orderId: input.orderId,
        type: input.type,
        ticketId: input.ticketId ?? null,
        note: input.note ?? null,
        metadata: input.metadata ?? undefined,
        ...(input.at ? { at: input.at } : {}),
      },
    });
  }

  /** Registra varios eventos en orden. */
  async recordMany(inputs: RecordEventInput[], tx?: TxClient) {
    for (const input of inputs) {
      await this.record(input, tx);
    }
  }

  /**
   * Registra `OPENED` solo si la orden aún no lo tiene (idempotente).
   */
  async ensureOpened(
    tenantId: string,
    orderId: string,
    at?: Date,
    tx?: TxClient,
  ) {
    const client = tx ?? this.prisma;
    const existing = await client.orderEvent.findFirst({
      where: { orderId, type: OrderEventType.OPENED },
    });
    if (existing) return existing;
    return this.record({ tenantId, orderId, type: OrderEventType.OPENED, at }, tx);
  }

  async listForOrder(orderId: string) {
    return this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { at: 'asc' },
    });
  }
}
