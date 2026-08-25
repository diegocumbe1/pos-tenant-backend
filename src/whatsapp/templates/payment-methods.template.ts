// Mensaje de "cómo pagarme" que el negocio le manda al cliente.
//
// Espeja shared/payments/payment-methods.ts del frontend a propósito: el cajero
// ve el texto antes de enviarlo y el backend lo puede armar solo (cobros
// automáticos, recordatorios de fiado) sin que el mensaje cambie de forma.

export interface BranchWalletPayload {
  id?: string;
  label?: string;
  reference?: string;
  instructions?: string;
}

export interface BranchPaymentInfoPayload {
  bankName?: string;
  accountType?: 'ahorros' | 'corriente';
  accountNumber?: string;
  accountHolder?: string;
  documentId?: string;
  nequiPhone?: string;
  daviplataPhone?: string;
  brebKey?: string;
  brebKeyType?: 'alfanumerica' | 'celular' | 'documento' | 'correo';
  wallets?: BranchWalletPayload[];
  qrImageUrl?: string;
  qrPdfUrl?: string;
  qrProvider?: 'nu' | 'other';
  transferInstructions?: string;
  showOnReceipt?: boolean;
}

export interface PaymentMethodEntry {
  label: string;
  reference: string;
  detail?: string;
}

const BREB_KEY_TYPE_LABELS: Record<string, string> = {
  alfanumerica: 'Alfanumérica (@)',
  celular: 'Celular',
  documento: 'Documento (#)',
  correo: 'Correo',
};

function accountLabel(info: BranchPaymentInfoPayload): string | undefined {
  if (!info.accountNumber) return undefined;
  const type =
    info.accountType === 'corriente'
      ? 'Corriente'
      : info.accountType === 'ahorros'
        ? 'Ahorros'
        : '';
  return [type, info.accountNumber].filter(Boolean).join(' · ');
}

/** Todo lo configurado para recibir plata, en el orden en que se le ofrece al cliente. */
export function listPaymentMethods(
  info: BranchPaymentInfoPayload | null | undefined,
): PaymentMethodEntry[] {
  if (!info) return [];
  const out: PaymentMethodEntry[] = [];

  if (info.brebKey?.trim()) {
    out.push({
      label: 'Bre-B',
      reference: info.brebKey.trim(),
      detail: [
        BREB_KEY_TYPE_LABELS[info.brebKeyType ?? ''] ?? 'Llave Bre-B',
        info.accountHolder,
      ]
        .filter(Boolean)
        .join(' · '),
    });
  }
  if (info.nequiPhone?.trim()) {
    out.push({
      label: 'Nequi',
      reference: info.nequiPhone.trim(),
      detail: info.accountHolder,
    });
  }
  if (info.daviplataPhone?.trim()) {
    out.push({
      label: 'Daviplata',
      reference: info.daviplataPhone.trim(),
      detail: info.accountHolder,
    });
  }
  for (const wallet of info.wallets ?? []) {
    if (!wallet?.label?.trim() || !wallet?.reference?.trim()) continue;
    out.push({
      label: wallet.label.trim(),
      reference: wallet.reference.trim(),
      detail: wallet.instructions?.trim() || info.accountHolder,
    });
  }
  const account = accountLabel(info);
  if (account) {
    out.push({
      label: info.bankName?.trim() || 'Transferencia bancaria',
      reference: account,
      detail:
        [info.accountHolder, info.documentId].filter(Boolean).join(' · ') ||
        undefined,
    });
  }
  const qrUrl = info.qrImageUrl || info.qrPdfUrl;
  if (qrUrl) {
    out.push({
      label: info.qrProvider === 'nu' ? 'QR Nu' : 'QR de pago',
      reference: qrUrl,
      detail: 'Escanea el QR desde tu banco',
    });
  }
  return out;
}

export interface PaymentMethodsTemplateInput {
  info: BranchPaymentInfoPayload | null | undefined;
  businessName?: string | null;
  amountCOP?: number | null;
  reference?: string | null;
  note?: string | null;
}

function formatCOP(value: number): string {
  return '$' + Math.round(value).toLocaleString('es-CO');
}

export function renderPaymentMethods({
  info,
  businessName,
  amountCOP,
  reference,
  note,
}: PaymentMethodsTemplateInput): string {
  const methods = listPaymentMethods(info);
  const lines: string[] = [];

  lines.push(businessName ? `*${businessName}* — Medios de pago` : '*Medios de pago*');
  if (typeof amountCOP === 'number' && amountCOP > 0) {
    lines.push(`Total a pagar: *${formatCOP(amountCOP)}*`);
  }
  if (reference?.trim()) lines.push(`Referencia: ${reference.trim()}`);
  lines.push('');

  if (methods.length === 0) {
    lines.push('(Aún no hay medios de pago configurados)');
  } else {
    for (const method of methods) {
      lines.push(`• *${method.label}*: ${method.reference}`);
      if (method.detail) lines.push(`   ${method.detail}`);
    }
  }

  const instructions = info?.transferInstructions?.trim();
  if (instructions) {
    lines.push('');
    lines.push(instructions);
  }
  if (note?.trim()) {
    lines.push('');
    lines.push(note.trim());
  }
  return lines.join('\n');
}
