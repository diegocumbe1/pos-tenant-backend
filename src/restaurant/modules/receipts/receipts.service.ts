import { randomBytes } from 'crypto';
import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrintingDocumentService } from '../printing/printing-document.service';
import { PrintDocument } from '../printing/printing.types';

const ORDER_INCLUDE = {
  items: true,
  table: { select: { code: true } },
  waiter: { select: { name: true } },
  tenant: { select: { name: true, documentId: true } },
  paymentSplits: { include: { contributions: true, items: true } },
} as const;

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: PrintingDocumentService,
  ) {}

  /** Endpoint autenticado: genera/recupera el recibo compartible de una orden. */
  async share(
    ctx: TenantContext,
    orderId: string,
    splitId?: string,
    payload?: Record<string, unknown>,
  ) {
    if (payload) {
      const result = await this.createFromPayload(ctx, orderId, payload, splitId);
      return { token: result.token, url: result.url };
    }

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, tenantId: ctx.tenantId },
      include: ORDER_INCLUDE,
    });
    if (!order) throw new NotFoundException(`Order ${orderId} not found`);
    const result = await this.createForOrder(order as OrderWithRelations, splitId);
    return { token: result.token, url: result.url };
  }

  /** Página pública sin auth: devuelve el PrintDocument del recibo. */
  async getPublic(token: string) {
    const share = await this.prisma.receiptShare.findUnique({
      where: { token },
    });
    const resolvedShare = share ?? (await this.findOrCreateByClosedOrderId(token));
    if (!resolvedShare) throw new NotFoundException('Receipt not found');
    if (resolvedShare.expiresAt && resolvedShare.expiresAt < new Date())
      throw new NotFoundException('Receipt expired');
    // No exponer tenant/branch/orderId; solo el documento re-renderizable.
    return { document: resolvedShare.payload, createdAt: resolvedShare.createdAt.toISOString() };
  }

  /**
   * Crea (idempotente por orden+split) el `ReceiptShare` y devuelve token/url +
   * el PrintDocument. Reutilizable desde el cierre de orden.
   */
  async createForOrder(order: OrderWithRelations, splitId?: string) {
    const existing = await this.prisma.receiptShare.findFirst({
      where: {
        tenantId: order.tenantId,
        orderId: order.id,
        splitId: splitId ?? null,
      },
    });
    if (existing) {
      return {
        token: existing.token,
        url: this.publicUrl(existing.token),
        document: existing.payload as unknown as PrintDocument,
        receiptShareId: existing.id,
      };
    }

    const token = this.generateToken();
    const document = this.buildDocument(order, splitId, this.publicUrl(token));

    const share = await this.prisma.receiptShare.create({
      data: {
        tenantId: order.tenantId,
        branchId: order.branchId,
        orderId: order.id,
        splitId: splitId ?? null,
        token,
        payload: document as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      token: share.token,
      url: this.publicUrl(share.token),
      document,
      receiptShareId: share.id,
    };
  }

  async createFromPayload(
    ctx: TenantContext,
    orderId: string,
    payload: Record<string, unknown>,
    splitId?: string,
  ) {
    const existing = await this.prisma.receiptShare.findFirst({
      where: {
        tenantId: ctx.tenantId,
        orderId,
        splitId: splitId ?? null,
      },
    });

    if (existing) {
      const updated = await this.prisma.receiptShare.update({
        where: { id: existing.id },
        data: { payload: payload as unknown as Prisma.InputJsonValue },
      });
      return {
        token: updated.token,
        url: this.publicUrl(updated.token),
        document: updated.payload as unknown as PrintDocument,
        receiptShareId: updated.id,
      };
    }

    const token = this.generateToken();
    const share = await this.prisma.receiptShare.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        orderId,
        splitId: splitId ?? null,
        token,
        payload: payload as unknown as Prisma.InputJsonValue,
      },
    });

    return {
      token: share.token,
      url: this.publicUrl(share.token),
      document: share.payload as unknown as PrintDocument,
      receiptShareId: share.id,
    };
  }

  buildDocument(
    order: OrderWithRelations,
    splitId?: string,
    publicUrl?: string | null,
  ): PrintDocument {
    const splits = order.paymentSplits ?? [];
    // El POS imprime el recibo con el split optimista (id local, p. ej. "PAY-001")
    // apenas se registra el cobro, antes de que la escritura llegue al servidor.
    // Si el split aún no existe aquí, el documento se arma con la orden completa:
    // es solo el andamio para acuñar el token/URL, porque el cliente sobrescribe
    // el payload con su propio documento en la segunda llamada a /share.
    const split = splitId ? splits.find((s) => s.id === splitId) : undefined;

    const items = split?.items?.length
      ? split.items.map((i) => ({ name: i.name, qty: i.qty, priceCOP: i.priceCOP }))
      : order.items.map((i) => ({ name: i.name, qty: i.qty, priceCOP: i.priceCOP }));

    const payments = split
      ? split.contributions.map((c) => ({
          method: c.method,
          amount: c.amount,
          cardType: c.cardType,
          cashReceived: c.cashReceived,
          cashChange: c.cashChange,
        }))
      : splits.flatMap((s) =>
          s.contributions.map((c) => ({
            method: c.method,
            amount: c.amount,
            cardType: c.cardType,
            cashReceived: c.cashReceived,
            cashChange: c.cashChange,
          })),
        );

    const subtotalCOP = items.reduce((sum, i) => sum + i.priceCOP * i.qty, 0);
    const totalCOP = split?.totalCOP ?? order.totalCOP ?? subtotalCOP;

    return this.docs.buildReceipt({
      orderId: order.id,
      splitId: splitId ?? null,
      tableCode: order.table?.code ?? null,
      waiterName: order.waiter?.name ?? null,
      businessName: order.tenant?.name ?? null,
      businessNit: order.tenant?.documentId ?? null,
      tenantId: order.tenantId,
      closedAt: order.closedAt ?? new Date(),
      items,
      payments,
      subtotalCOP,
      totalCOP,
      publicUrl: publicUrl ?? null,
    });
  }

  private generateToken() {
    return randomBytes(18).toString('base64url'); // ~24 chars, impredecible
  }

  private async findOrCreateByClosedOrderId(orderId: string) {
    const existing = await this.prisma.receiptShare.findFirst({
      where: { orderId, splitId: null },
      orderBy: { createdAt: 'desc' },
    });
    if (existing) return existing;

    const order = await this.prisma.order.findFirst({
      where: { id: orderId, status: 'CLOSED' },
      include: ORDER_INCLUDE,
    });
    if (!order) return null;

    const created = await this.createForOrder(order as OrderWithRelations);
    return this.prisma.receiptShare.findUnique({
      where: { id: created.receiptShareId },
    });
  }

  private publicUrl(token: string) {
    const base = process.env.PUBLIC_APP_URL?.replace(/\/$/, '');
    if (base) return `${base}/r/${token}`;
    return process.env.NODE_ENV === 'production'
      ? `https://uselynko.com/r/${token}`
      : `/r/${token}`;
  }
}

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;
