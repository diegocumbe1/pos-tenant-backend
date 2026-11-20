import { Injectable } from '@nestjs/common';
import { OrderEventType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';

type TxClient = Prisma.TransactionClient | PrismaService;

/** Quien hizo la acción. Basta con pasar el `TenantContext` de la petición. */
export interface EventActor {
  userId?: string | null;
  name?: string | null;
  roleCode?: string | null;
}

export interface RecordEventInput {
  tenantId: string;
  orderId: string;
  type: OrderEventType;
  ticketId?: string | null;
  note?: string | null;
  metadata?: Prisma.InputJsonValue;
  at?: Date;
  /** Quién lo hizo (mesero, cajero, dueño, administrador). Sin actor = sistema o dato antiguo. */
  actor?: EventActor | null;
}

function actorData(actor?: EventActor | null) {
  return {
    actorId: actor?.userId ?? null,
    actorName: actor?.name ?? null,
    actorRole: actor?.roleCode ?? null,
  };
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
        ...actorData(input.actor),
        ...(input.at ? { at: input.at } : {}),
      },
    });
  }

  /**
   * Registra varios eventos en una sola query (`createMany`).
   *
   * Antes iteraba con un `await` por evento: con la DB lejos (p.ej. pooler en
   * otra región, ~200ms por round-trip) eso multiplicaba la latencia y podía
   * reventar el timeout de la transacción que lo envuelve (Prisma P2028).
   */
  async recordMany(inputs: RecordEventInput[], tx?: TxClient) {
    if (inputs.length === 0) return;
    const client = tx ?? this.prisma;
    return client.orderEvent.createMany({
      data: inputs.map((input) => ({
        tenantId: input.tenantId,
        orderId: input.orderId,
        type: input.type,
        ticketId: input.ticketId ?? null,
        note: input.note ?? null,
        metadata: input.metadata ?? undefined,
        ...actorData(input.actor),
        ...(input.at ? { at: input.at } : {}),
      })),
    });
  }

  /**
   * Registra `OPENED` solo si la orden aún no lo tiene (idempotente).
   */
  async ensureOpened(
    tenantId: string,
    orderId: string,
    at?: Date,
    tx?: TxClient,
    actor?: EventActor | null,
  ) {
    const client = tx ?? this.prisma;
    const existing = await client.orderEvent.findFirst({
      where: { orderId, type: OrderEventType.OPENED },
    });
    if (existing) return existing;
    return this.record({ tenantId, orderId, type: OrderEventType.OPENED, at, actor }, tx);
  }

  async listForOrder(orderId: string) {
    return this.prisma.orderEvent.findMany({
      where: { orderId },
      orderBy: { at: 'asc' },
    });
  }
}
