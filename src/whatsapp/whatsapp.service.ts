import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import {
  IMessagingProvider,
  MESSAGING_PROVIDER,
} from './providers/messaging-provider.interface';
import {
  AppointmentTemplateInput,
  renderBusinessNotification,
  renderCustomerConfirmation,
} from './templates/appointment.templates';
import {
  BranchPaymentInfoPayload,
  renderPaymentMethods,
} from './templates/payment-methods.template';

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

@Injectable()
export class WhatsAppService {
  constructor(
    @Inject(MESSAGING_PROVIDER) private readonly provider: IMessagingProvider,
    private readonly prisma: PrismaService,
  ) {}

  async sendAppointmentCreatedToBusiness(
    ctx: TenantContext,
    dto: NotifyAppointmentDto,
  ): Promise<{ id: string }> {
    if (!dto.businessPhone) {
      throw new Error('businessPhone is required to notify the business');
    }
    const body = renderBusinessNotification(dto as AppointmentTemplateInput);
    return this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to: dto.businessPhone,
      body,
    });
  }

  async sendAppointmentConfirmationToCustomer(
    ctx: TenantContext,
    dto: NotifyAppointmentDto,
  ): Promise<{ id: string }> {
    const body = renderCustomerConfirmation(dto as AppointmentTemplateInput);
    return this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to: dto.customerPhone,
      body,
    });
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
