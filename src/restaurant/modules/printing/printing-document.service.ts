import { Injectable } from '@nestjs/common';
import { PrintDocumentType, PrinterTarget } from '@prisma/client';
import { PrintBlock, PrintDocument } from './printing.types';

const COP = new Intl.NumberFormat('es-CO', {
  style: 'currency',
  currency: 'COP',
  maximumFractionDigits: 0,
});

export interface KitchenTicketDoc {
  ticketId: string;
  orderId: string;
  tenantId?: string | null;
  tableCode?: string | null;
  waiterName?: string | null;
  priority?: string | null;
  sentAt: Date;
  items: Array<{
    name: string;
    qty: number;
    notes?: string | null;
    additions?: string[];
    modifiers?: string[];
  }>;
}

export interface ReceiptDoc {
  orderId: string;
  splitId?: string | null;
  tableCode?: string | null;
  waiterName?: string | null;
  businessName?: string | null;
  businessNit?: string | null;
  tenantId?: string | null;
  closedAt: Date;
  items: Array<{ name: string; qty: number; priceCOP: number }>;
  payments: Array<{
    method: string;
    amount: number;
    cardType?: string | null;
    cashReceived?: number | null;
    cashChange?: number | null;
  }>;
  subtotalCOP: number;
  totalCOP: number;
  publicUrl?: string | null;
}

export interface ZReportDoc {
  sessionId: string;
  terminalId: string;
  businessName?: string | null;
  openedAt: Date;
  closedAt: Date;
  openingAmount: number;
  expectedAmount: number;
  countedAmount: number;
  difference: number;
  totalsByMethod: Array<{ method: string; total: number }>;
  movementCounts: { sales: number; refunds: number; other: number };
}

/**
 * Construye los `PrintDocument` autoritativos. Bloques con `kind` según el
 * contrato del frontend (Anexo A §A2).
 */
@Injectable()
export class PrintingDocumentService {
  private shortOrderCode(orderId: string, tenantId?: string | null, date?: Date): string {
    const dateKey = (date ?? new Date()).toISOString().slice(0, 10).replace(/-/g, '');
    const seed = `${tenantId ?? ''}|${dateKey}|${orderId}`;
    let hash = 2166136261;
    for (let i = 0; i < seed.length; i += 1) {
      hash ^= seed.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return String(hash >>> 0).padStart(10, '0').slice(-8);
  }

  buildKitchenTicket(input: KitchenTicketDoc): PrintDocument {
    const orderCode = this.shortOrderCode(input.orderId, input.tenantId, input.sentAt);
    const blocks: PrintBlock[] = [
      { kind: 'text', text: 'COMANDA COCINA', align: 'center', bold: true, size: 'lg' },
      { kind: 'line' },
    ];
    if (input.tableCode)
      blocks.push({ kind: 'row', left: 'Mesa', right: input.tableCode });
    if (input.waiterName)
      blocks.push({ kind: 'row', left: 'Mesero', right: input.waiterName });
    blocks.push({ kind: 'row', left: 'Fecha', right: this.date(input.sentAt) });
    blocks.push({ kind: 'row', left: 'Hora', right: this.time(input.sentAt) });
    if (input.priority && input.priority !== 'normal')
      blocks.push({
        kind: 'text',
        text: `** ${input.priority.toUpperCase()} **`,
        align: 'center',
        bold: true,
      });
    blocks.push({ kind: 'line' });
    for (const item of input.items) {
      blocks.push({ kind: 'text', text: `${item.qty}x  ${item.name}`, size: 'md', bold: true });
      // Opciones/especificaciones del plato, debajo del nombre.
      for (const mod of item.modifiers ?? [])
        blocks.push({ kind: 'text', text: `   + ${mod}`, size: 'sm' });
      for (const add of item.additions ?? [])
        blocks.push({ kind: 'text', text: `   + ${add}`, size: 'sm' });
      if (item.notes && item.notes.trim())
        blocks.push({ kind: 'text', text: `   ** ${item.notes.trim()}`, size: 'sm', bold: true });
    }
    blocks.push({ kind: 'feed', lines: 1 });
    blocks.push({ kind: 'text', text: `Orden #${orderCode}`, align: 'center', size: 'sm' });
    blocks.push({ kind: 'cut' });

    return this.doc(
      `KITCHEN-${input.ticketId}`,
      PrintDocumentType.KITCHEN_TICKET,
      PrinterTarget.KITCHEN,
      blocks,
      { orderId: input.orderId, ticketId: input.ticketId },
    );
  }

  buildReceipt(input: ReceiptDoc): PrintDocument {
    const orderCode = this.shortOrderCode(input.orderId, input.tenantId, input.closedAt);
    const blocks: PrintBlock[] = [
      { kind: 'drawer' },
      { kind: 'text', text: input.businessName ?? 'Recibo', align: 'center', bold: true, size: 'lg' },
      { kind: 'text', text: 'RECIBO DE VENTA', align: 'center', size: 'sm' },
      ...(input.businessNit?.trim()
        ? [{ kind: 'text', text: `NIT: ${input.businessNit.trim()}`, align: 'center', size: 'sm' } as PrintBlock]
        : []),
      { kind: 'line' },
    ];
    if (input.tableCode)
      blocks.push({ kind: 'row', left: 'Mesa', right: input.tableCode });
    if (input.waiterName)
      blocks.push({ kind: 'row', left: 'Atendió', right: input.waiterName });
    blocks.push({ kind: 'row', left: 'Orden', right: orderCode });
    blocks.push({ kind: 'row', left: 'Fecha', right: this.dateTime(input.closedAt) });
    blocks.push({ kind: 'line' });

    for (const item of input.items) {
      blocks.push({
        kind: 'row',
        left: `${item.qty}x ${item.name}`,
        right: COP.format(item.priceCOP * item.qty),
      });
    }
    blocks.push({ kind: 'line' });
    blocks.push({ kind: 'row', left: 'Subtotal', right: COP.format(input.subtotalCOP) });
    blocks.push({ kind: 'row', left: 'TOTAL', right: COP.format(input.totalCOP), bold: true });
    blocks.push({ kind: 'feed', lines: 1 });

    for (const pay of input.payments) {
      const label = pay.cardType ? `${pay.method} (${pay.cardType})` : pay.method;
      blocks.push({ kind: 'row', left: this.capitalize(label), right: COP.format(pay.amount) });
      if (pay.method === 'cash' && pay.cashReceived != null && pay.cashReceived > pay.amount) {
        blocks.push({ kind: 'row', left: '  Recibido', right: COP.format(pay.cashReceived) });
        blocks.push({
          kind: 'row',
          left: '  Cambio',
          right: COP.format(pay.cashChange ?? pay.cashReceived - pay.amount),
        });
      }
    }

    if (input.publicUrl) {
      blocks.push({ kind: 'feed', lines: 1 });
      blocks.push({ kind: 'text', text: 'Recibo digital', align: 'center', size: 'sm' });
      blocks.push({ kind: 'text', text: input.publicUrl, align: 'center', size: 'sm' });
    }
    blocks.push({ kind: 'feed', lines: 1 });
    blocks.push({ kind: 'text', text: 'Sin valor fiscal', align: 'center', size: 'sm' });
    blocks.push({ kind: 'cut' });

    return this.doc(
      input.splitId ? `RECEIPT-${input.orderId}-${input.splitId}` : `RECEIPT-${input.orderId}`,
      PrintDocumentType.RECEIPT,
      PrinterTarget.CASHIER,
      blocks,
      input.splitId
        ? { orderId: input.orderId, splitId: input.splitId }
        : { orderId: input.orderId },
    );
  }

  buildZReport(input: ZReportDoc): PrintDocument {
    const blocks: PrintBlock[] = [
      { kind: 'text', text: input.businessName ?? 'Arqueo', align: 'center', bold: true, size: 'lg' },
      { kind: 'text', text: 'CIERRE DE CAJA (Z)', align: 'center', size: 'sm' },
      { kind: 'line' },
      { kind: 'row', left: 'Terminal', right: input.terminalId },
      { kind: 'row', left: 'Apertura', right: this.dateTime(input.openedAt) },
      { kind: 'row', left: 'Cierre', right: this.dateTime(input.closedAt) },
      { kind: 'line' },
      { kind: 'row', left: 'Base inicial', right: COP.format(input.openingAmount) },
    ];
    for (const t of input.totalsByMethod) {
      blocks.push({ kind: 'row', left: this.capitalize(t.method), right: COP.format(t.total) });
    }
    blocks.push({ kind: 'line' });
    blocks.push({ kind: 'row', left: 'Esperado', right: COP.format(input.expectedAmount) });
    blocks.push({ kind: 'row', left: 'Contado', right: COP.format(input.countedAmount) });
    blocks.push({ kind: 'row', left: 'Diferencia', right: COP.format(input.difference), bold: true });
    blocks.push({ kind: 'feed', lines: 1 });
    blocks.push({
      kind: 'text',
      text: `Ventas: ${input.movementCounts.sales}  Devol: ${input.movementCounts.refunds}`,
      align: 'center',
      size: 'sm',
    });
    blocks.push({ kind: 'cut' });

    return this.doc(
      `zreport-${input.sessionId}`,
      PrintDocumentType.Z_REPORT,
      PrinterTarget.CASHIER,
      blocks,
      { sessionId: input.sessionId, terminalId: input.terminalId },
    );
  }

  private doc(
    id: string,
    type: PrintDocumentType,
    printerTarget: PrinterTarget,
    blocks: PrintBlock[],
    meta?: Record<string, string>,
  ): PrintDocument {
    return { id, type, printerTarget, createdAt: new Date().toISOString(), blocks, meta };
  }

  private time(d: Date) {
    return d.toLocaleTimeString('es-CO', {
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Bogota',
    });
  }

  private date(d: Date) {
    return d.toLocaleDateString('es-CO', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      timeZone: 'America/Bogota',
    });
  }

  private dateTime(d: Date) {
    return d.toLocaleString('es-CO', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      timeZone: 'America/Bogota',
    });
  }

  private capitalize(s: string) {
    return s.charAt(0).toUpperCase() + s.slice(1);
  }
}
