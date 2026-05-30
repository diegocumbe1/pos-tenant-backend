import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CancelBarberAppointmentDto,
  CreateBarberAppointmentDto,
  UpdateBarberAppointmentDto,
} from './dto/barber-appointment.dto';

@Injectable()
export class BarberAppointmentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async listAppointments(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberAppointment.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { customer: true, service: true, staff: true },
      orderBy: { scheduledAt: 'asc' },
    });
  }

  async createAppointment(ctx: TenantContext, dto: CreateBarberAppointmentDto) {
    await this.assertAppointmentRelations(ctx, {
      customerId: dto.customerId,
      serviceId: dto.serviceId,
      staffId: dto.staffId,
    });

    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: dto.serviceId },
      select: { durationMin: true },
    });
    const scheduledAt = new Date(dto.scheduledAt);
    const scheduledEnd = new Date(
      scheduledAt.getTime() + service.durationMin * 60_000,
    );

    return this.prisma.barberAppointment.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        customerId: dto.customerId,
        serviceId: dto.serviceId,
        staffId: dto.staffId,
        scheduledAt,
        scheduledEnd,
        notes: dto.notes,
      },
      include: { customer: true, service: true, staff: true },
    });
  }

  async updateAppointment(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberAppointmentDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    await this.assertAppointmentRelations(ctx, {
      customerId: dto.customerId,
      serviceId: dto.serviceId,
      staffId: dto.staffId,
    });

    const serviceId =
      dto.serviceId ??
      (
        await this.prisma.barberAppointment.findUniqueOrThrow({
          where: { id },
          select: { serviceId: true },
        })
      ).serviceId;
    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: serviceId },
      select: { durationMin: true },
    });
    const scheduledAt = dto.scheduledAt ? new Date(dto.scheduledAt) : undefined;

    return this.prisma.barberAppointment.update({
      where: { id },
      data: {
        customerId: dto.customerId,
        serviceId: dto.serviceId,
        staffId: dto.staffId,
        scheduledAt,
        scheduledEnd: scheduledAt
          ? new Date(scheduledAt.getTime() + service.durationMin * 60_000)
          : undefined,
        status: dto.status,
        notes: dto.notes,
      },
      include: { customer: true, service: true, staff: true },
    });
  }

  async cancelAppointment(
    ctx: TenantContext,
    id: string,
    dto: CancelBarberAppointmentDto,
  ) {
    await this.tenantHelper.assertScopedRecord(
      'barberAppointment',
      ctx,
      id,
      'Appointment',
    );
    return this.prisma.barberAppointment.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: dto.reason },
      include: { customer: true, service: true, staff: true },
    });
  }

  private async assertAppointmentRelations(
    ctx: TenantContext,
    ids: { customerId?: string; serviceId?: string; staffId?: string },
  ) {
    await Promise.all([
      ids.customerId
        ? this.tenantHelper.assertScopedRecord(
            'barberCustomer',
            ctx,
            ids.customerId,
            'Customer',
          )
        : Promise.resolve(),
      ids.serviceId
        ? this.tenantHelper.assertScopedRecord(
            'barberService',
            ctx,
            ids.serviceId,
            'Service',
          )
        : Promise.resolve(),
      ids.staffId
        ? this.tenantHelper.assertScopedRecord(
            'barberStaff',
            ctx,
            ids.staffId,
            'Staff',
          )
        : Promise.resolve(),
    ]);
  }
}
