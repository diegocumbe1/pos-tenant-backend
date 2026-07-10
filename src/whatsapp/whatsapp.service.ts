import { Inject, Injectable } from '@nestjs/common';
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
}
