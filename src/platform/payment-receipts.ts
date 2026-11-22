import {
  Controller,
  Get,
  Header,
  Injectable,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';
import { RECEIPT_TOKEN_RE } from './payment-installments';

const METHOD_LABELS: Record<string, string> = {
  card: 'Tarjeta',
  bank_transfer: 'Transferencia',
  transfer: 'Transferencia',
  bre_b: 'Bre-B',
  nequi: 'Nequi',
  daviplata: 'Daviplata',
  cash: 'Efectivo',
};

/**
 * Comprobante de pago público: `/comprobante/<token>` en la web.
 *
 * NO es una factura electrónica ni un documento tributario DIAN: es la
 * constancia de un pago registrado. La única llave es el token (144 bits); uno
 * inexistente o malformado responde 404 igual, sin pistas. No sale ningún id
 * interno, ni quién registró el pago, ni datos de otros pagos del cliente.
 */
@Injectable()
export class PaymentReceiptsService {
  constructor(private readonly prisma: PrismaService) {}

  async getPublicView(token: string) {
    if (!RECEIPT_TOKEN_RE.test(token)) throw new NotFoundException();
    const p = await this.prisma.subscriptionPayment.findUnique({
      where: { receiptToken: token },
      include: { tenant: { select: { name: true } } },
    });
    // Un bono o una nota crédito no son un pago: no se comprueba nada.
    if (!p || p.kind !== 'payment') throw new NotFoundException();

    const listAmount = p.officialPrice ?? p.amount;
    const hasPlan =
      !!p.installmentNo &&
      !!p.installmentsTotal &&
      p.planTotal != null &&
      p.balanceAfter != null;

    return {
      number: `CP-${p.id.slice(-8).toUpperCase()}`,
      businessName: p.tenant.name,
      plan: p.plan,
      currency: p.currency,
      amount: p.amount,
      listAmount,
      discountAmount: p.discountApplied,
      discountReason: p.discountReason,
      method: METHOD_LABELS[p.method] ?? 'Otro',
      reference: p.reference,
      paidAt: p.paidAt,
      periodStart: p.periodStart,
      periodEnd: p.periodEnd,
      // Nota legal: la tarifa de la tabla el día que se contrató. El descuento
      // adicional es lo que se rebajó POR ENCIMA de la tabla (si se acordó menos).
      tariff:
        p.tariffTableTotal != null && p.tariffTermMonths != null
          ? {
              termMonths: p.tariffTermMonths,
              listMonthly: p.tariffListMonthly,
              discountBps: p.tariffDiscountBps ?? 0,
              tableTotal: p.tariffTableTotal,
              extraDiscount: Math.max(
                0,
                p.tariffTableTotal - (hasPlan ? p.planTotal! : p.amount),
              ),
              effectiveAt: p.paidAt,
            }
          : null,
      installment: hasPlan
        ? {
            number: p.installmentNo,
            total: p.installmentsTotal,
            planTotal: p.planTotal,
            planListTotal: p.planListTotal ?? p.planTotal,
            planSavings: Math.max(
              0,
              (p.planListTotal ?? p.planTotal!) - p.planTotal!,
            ),
            paidToDate: p.planTotal! - p.balanceAfter!,
            balance: p.balanceAfter,
            nextDueAt: p.nextDueAt,
            nextDueAmount: p.nextDueAmount,
          }
        : null,
    };
  }
}

@ApiTags('PublicPaymentReceipts')
@Controller('public/payment-receipts')
export class PublicPaymentReceiptsController {
  constructor(private readonly receipts: PaymentReceiptsService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Comprobante de pago por token (público)' })
  get(@Param('token') token: string) {
    return this.receipts.getPublicView(token);
  }
}
