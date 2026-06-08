import { PrintDocumentType, PrinterTarget } from '@prisma/client';

/**
 * Contrato de impresión — debe coincidir con
 * `verticals/restaurant/types/printing.types.ts` del frontend (Anexo A §A2).
 * El backend es autoritativo: genera el `PrintDocument` y el agente/driver
 * (o `window.print` en el front) lo renderiza a HTML/ESC-POS/PDF.
 */
export type PrintAlign = 'left' | 'center' | 'right';
export type PrintSize = 'sm' | 'md' | 'lg';

export type PrintBlock =
  | { kind: 'text'; text: string; align?: PrintAlign; bold?: boolean; size?: PrintSize }
  | { kind: 'line' }
  | { kind: 'row'; left: string; right: string; bold?: boolean }
  | { kind: 'qr'; data: string; size?: number }
  | { kind: 'barcode'; data: string; format?: 'CODE128' | 'EAN13' }
  | { kind: 'image'; url: string }
  | { kind: 'feed'; lines: number }
  | { kind: 'cut' };

export interface PrintDocument {
  /** Idempotency key. Estable para un mismo documento lógico. */
  id: string;
  type: PrintDocumentType;
  printerTarget: PrinterTarget;
  createdAt: string; // ISO
  blocks: PrintBlock[];
  meta?: Record<string, string>;
}
