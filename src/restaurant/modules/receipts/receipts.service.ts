import { randomBytes } from 'crypto';
import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrintingDocumentService } from '../printing/printing-document.service';
import { PrintDocument } from '../printing/printing.types';

const ORDER_INCLUDE = {
  items: true,
  table: { select: { code: true } },
  waiter: { select: { name: true } },
  tenant: { select: { name: true } },
  paymentSplits: { include: { contributions: true, items: true } },
} as const;

@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly docs: PrintingDocumentService,
  ) {}

  /** Endpoint autenticado: genera/recupera el recibo compartible de una orden. */
  async share(ctx: TenantContext, orderId: string, splitId?: string) {
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
    if (!share) throw new NotFoundException('Receipt not found');
    if (share.expiresAt && share.expiresAt < new Date())
      throw new NotFoundException('Receipt expired');
    // No exponer tenant/branch/orderId; solo el documento re-renderizable.
    return { document: share.payload, createdAt: share.createdAt.toISOString() };
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

  buildDocument(
    order: OrderWithRelations,
    splitId?: string,
    publicUrl?: string | null,
  ): PrintDocument {
    const splits = order.paymentSplits ?? [];
    const split = splitId ? splits.find((s) => s.id === splitId) : undefined;
    if (splitId && !split)
      throw new UnprocessableEntityException(`Split ${splitId} not found`);

    const items = split?.items?.length
      ? split.items.map((i) => ({ name: i.name, qty: i.qty, priceCOP: i.priceCOP }))
      : order.items.map((i) => ({ name: i.name, qty: i.qty, priceCOP: i.priceCOP }));

    const payments = split
      ? split.contributions.map((c) => ({
          method: c.method,
          amount: c.amount,
          cardType: c.cardType,
        }))
      : splits.flatMap((s) =>
          s.contributions.map((c) => ({
            method: c.method,
            amount: c.amount,
            cardType: c.cardType,
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

  private publicUrl(token: string) {
    const base = process.env.PUBLIC_APP_URL?.replace(/\/$/, '');
    return base ? `${base}/r/${token}` : `/r/${token}`;
  }
}

export type OrderWithRelations = Prisma.OrderGetPayload<{
  include: typeof ORDER_INCLUDE;
}>;
