import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { CO_LOCALE, CO_TZ, formatCOP, formatDateLongCO } from '../common/date.util';
import {
  IMessagingProvider,
  MESSAGING_PROVIDER,
} from './providers/messaging-provider.interface';
import {
  BranchPaymentInfoPayload,
  renderPaymentMethods,
} from './templates/payment-methods.template';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import { WhatsappTemplateKey } from './templates/message-templates';

export interface SendPaymentMethodsInput {
  to: string;
  /** Texto ya revisado por el cajero. Sin él se arma con el paymentInfo de la sede. */
  body?: string;
  amountCOP?: number;
  reference?: string;
  note?: string;
}

export interface NotifyAppointmentDto {
  customerName: string;
  customerPhone: string;
  serviceName: string;
  specialistName?: string;
  startTime: string;
  businessName: string;
  businessPhone?: string;
}

export interface OrderLineInput {
  name: string;
  quantity: number;
}

export interface NotifyOrderDto {
  customerName: string;
  customerPhone: string;
  /** Consecutivo o referencia visible del pedido. */
  orderCode?: string;
  items: OrderLineInput[];
  totalCOP: number;
  /** Cómo lo recibe: domicilio, recoge en tienda, dirección… */
  deliveryNote?: string;
  createdAt?: string;
  businessName: string;
  businessPhone?: string;
}

/** '3:45 p. m.' en hora Colombia. */
function formatClockCO(value: Date | string): string {
  return new Intl.DateTimeFormat(CO_LOCALE, {
    timeZone: CO_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

/** '2 x Camiseta negra, 1 x Gorra' */
function formatOrderLines(items: OrderLineInput[]): string {
  return items
    .filter((item) => item?.name)
    .map((item) => `${item.quantity} x ${item.name}`)
    .join(', ');
}

/**
 * Mensajería de WhatsApp del negocio hacia sus clientes.
 *
 * Ningún texto se arma aquí: el cuerpo sale de `WhatsappTemplatesService`, que
 * devuelve lo que el dueño editó en Ajustes o el default del código. Este
 * servicio solo resuelve los valores de los tokens y entrega al proveedor.
 *
 * `render` devuelve `null` cuando el negocio apagó ese aviso; en ese caso no se
 * envía nada y la respuesta lo dice, en vez de fallar.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);

  constructor(
    @Inject(MESSAGING_PROVIDER) private readonly provider: IMessagingProvider,
    private readonly prisma: PrismaService,
    private readonly templates: WhatsappTemplatesService,
  ) {}

  private appointmentValues(
    dto: NotifyAppointmentDto,
  ): Record<string, string | undefined> {
    return {
      '{negocio}': dto.businessName,
      '{cliente}': dto.customerName,
      '{telefono}': dto.customerPhone,
      '{servicio}': dto.serviceName,
      '{fecha}': formatDateLongCO(dto.startTime),
      '{hora}': formatClockCO(dto.startTime),
      '{especialista}': dto.specialistName,
    };
  }

  private orderValues(dto: NotifyOrderDto): Record<string, string | undefined> {
    return {
      '{negocio}': dto.businessName,
      '{cliente}': dto.customerName,
      '{telefono}': dto.customerPhone,
      '{pedido}': dto.orderCode,
      '{productos}': formatOrderLines(dto.items ?? []),
      '{total}': formatCOP(dto.totalCOP ?? 0),
      '{fecha}': formatDateLongCO(dto.createdAt ?? new Date()),
      '{entrega}': dto.deliveryNote,
    };
  }

  /**
   * Renderiza y envía. Devuelve `skipped` cuando la plantilla está apagada, que
   * es una decisión del negocio y no un error.
   */
  private async sendTemplate(
    ctx: TenantContext,
    key: WhatsappTemplateKey,
    to: string,
    values: Record<string, string | undefined>,
  ): Promise<{ id: string } | { skipped: true; reason: string }> {
    const body = await this.templates.render(ctx.tenantId, key, values);
    if (!body) {
      return { skipped: true, reason: 'template_disabled' };
    }
    this.logger.log(`Enviando ${key} a ${to} (tenant ${ctx.tenantId})`);
    return this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to,
      body,
    });
  }

  async sendAppointmentCreatedToBusiness(
    ctx: TenantContext,
    dto: NotifyAppointmentDto,
  ) {
    if (!dto.businessPhone) {
      throw new BadRequestException(
        'businessPhone is required to notify the business',
      );
    }
    return this.sendTemplate(
      ctx,
      'APPOINTMENT_BUSINESS',
      dto.businessPhone,
      this.appointmentValues(dto),
    );
  }

  async sendAppointmentConfirmationToCustomer(
    ctx: TenantContext,
    dto: NotifyAppointmentDto,
  ) {
    return this.sendTemplate(
      ctx,
      'APPOINTMENT_CUSTOMER',
      dto.customerPhone,
      this.appointmentValues(dto),
    );
  }

  /** Retail: aviso al negocio de que entró un pedido del catálogo público. */
  async sendOrderCreatedToBusiness(ctx: TenantContext, dto: NotifyOrderDto) {
    if (!dto.businessPhone) {
      throw new BadRequestException(
        'businessPhone is required to notify the business',
      );
    }
    return this.sendTemplate(
      ctx,
      'ORDER_BUSINESS',
      dto.businessPhone,
      this.orderValues(dto),
    );
  }

  /** Retail: confirmación del pedido al cliente que lo hizo. */
  async sendOrderConfirmationToCustomer(
    ctx: TenantContext,
    dto: NotifyOrderDto,
  ) {
    return this.sendTemplate(
      ctx,
      'ORDER_CUSTOMER',
      dto.customerPhone,
      this.orderValues(dto),
    );
  }

  async sendRaw(
    ctx: TenantContext,
    to: string,
    body: string,
  ): Promise<{ id: string }> {
    return this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to,
      body,
    });
  }

  /**
   * Manda al cliente cómo pagarle al negocio (llave Bre-B, billeteras, cuenta,
   * QR). Es agnóstico de vertical: los datos viven en la sede, así que sirve
   * igual para una mesa de restaurante, un corte o una venta de mostrador.
   *
   * No pasa por `WhatsappTemplatesService` a propósito: el cuerpo se arma con
   * los medios de pago configurados en la sede, no es un texto que el dueño
   * redacte.
   */
  async sendPaymentMethods(
    ctx: TenantContext,
    input: SendPaymentMethodsInput,
  ): Promise<{ id: string }> {
    let body = input.body?.trim();

    if (!body) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: ctx.branchId, tenantId: ctx.tenantId },
        select: { paymentInfo: true, tenant: { select: { name: true } } },
      });
      if (!branch) throw new BadRequestException('Branch not found');
      body = renderPaymentMethods({
        info: branch.paymentInfo as BranchPaymentInfoPayload | null,
        businessName: branch.tenant?.name,
        amountCOP: input.amountCOP,
        reference: input.reference,
        note: input.note,
      });
    }

    return this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to: input.to,
      body,
    });
  }
}
