import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import {
  CancelBarberAppointmentDto,
  CreateBarberAppointmentDto,
  UpdateBarberAppointmentDto,
} from './dto/barber-appointment.dto';
import {
  CreateBarberCustomerDto,
  UpdateBarberCustomerDto,
} from './dto/barber-customer.dto';
import {
  CreateBarberServiceDto,
  UpdateBarberServiceDto,
} from './dto/barber-service.dto';
import { UpdateBarberSettingsDto } from './dto/barber-settings.dto';
import {
  CreateBarberStaffDto,
  UpdateBarberStaffDto,
} from './dto/barber-staff.dto';

const RESERVED_BOOKING_SLUGS = new Set([
  'api',
  'admin',
  'app',
  'auth',
  'barber',
  'dashboard',
  'login',
  'settings',
]);

@Injectable()
export class BarberService {
  constructor(private readonly prisma: PrismaService) {}

  async getSettings(ctx: TenantContext) {
    const settings = await this.ensureSettings(ctx);
    return this.toSettingsDto(settings);
  }

  async updateSettings(ctx: TenantContext, dto: UpdateBarberSettingsDto) {
    const current = await this.ensureSettings(ctx);

    if (dto.bookingSlug && dto.bookingSlug !== current.bookingSlug) {
      await this.assertBookingSlugAvailable(dto.bookingSlug, ctx.tenantId);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.business?.businessName) {
        await tx.tenant.update({
          where: { id: ctx.tenantId },
          data: { name: dto.business.businessName },
        });
      }

      if (dto.business?.branchName || dto.business?.address !== undefined) {
        await tx.branch.update({
          where: { id: ctx.branchId },
          data: {
            name: dto.business.branchName,
            address: dto.business.address,
          },
        });
      }

      return tx.barberSettings.update({
        where: { branchId: ctx.branchId },
        data: {
          phone: dto.business?.phone,
          city: dto.business?.city,
          timezone: dto.timezone,
          currency: dto.currency,
          logoUrl: dto.logoUrl,
          bookingSlug: dto.bookingSlug,
          onlineBookingEnabled: dto.onlineBookingEnabled,
          whatsappEnabled: dto.whatsappEnabled,
          loyaltyEnabled: dto.loyaltyEnabled,
          themeTemplateId: dto.theme?.templateId,
          themePrimaryColor: dto.theme?.primaryColor,
          themeAccentColor: dto.theme?.accentColor,
          themeLogoMode: dto.theme?.logoMode,
          themeLogoImageUrl: dto.theme?.logoImageUrl,
          themeBannerImageUrl: dto.theme?.bannerImageUrl,
          heroTitle: dto.theme?.heroTitle,
          heroDescription: dto.theme?.heroDescription,
        },
      });
    });

    return this.toSettingsDto(updated);
  }

  async listServices(ctx: TenantContext) {
    await this.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberService.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createService(ctx: TenantContext, dto: CreateBarberServiceDto) {
    await this.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberService.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        description: dto.description,
        durationMin: dto.durationMin,
        priceCOP: dto.priceCOP,
        color: dto.color,
        sortOrder: dto.sortOrder,
      },
    });
  }

  async updateService(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberServiceDto,
  ) {
    await this.assertScopedRecord('barberService', ctx, id, 'Service');
    return this.prisma.barberService.update({
      where: { id },
      data: dto,
    });
  }

  async deleteService(ctx: TenantContext, id: string) {
    await this.assertScopedRecord('barberService', ctx, id, 'Service');
    await this.prisma.barberService.update({
      where: { id },
      data: { isActive: false },
    });
    return { ok: true };
  }

  async listStaff(ctx: TenantContext) {
    await this.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberStaff.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { services: { include: { service: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async createStaff(ctx: TenantContext, dto: CreateBarberStaffDto) {
    await this.assertBarberTenant(ctx.tenantId);
    await this.assertServicesBelongToBranch(ctx, dto.serviceIds ?? []);
    return this.prisma.barberStaff.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        avatarUrl: dto.avatarUrl,
        color: dto.color,
        bio: dto.bio,
        sortOrder: dto.sortOrder,
        services: dto.serviceIds
          ? { create: dto.serviceIds.map((serviceId) => ({ serviceId })) }
          : undefined,
      },
      include: { services: { include: { service: true } } },
    });
  }

  async updateStaff(ctx: TenantContext, id: string, dto: UpdateBarberStaffDto) {
    await this.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    await this.assertServicesBelongToBranch(ctx, dto.serviceIds ?? []);

    return this.prisma.$transaction(async (tx) => {
      const staff = await tx.barberStaff.update({
        where: { id },
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          avatarUrl: dto.avatarUrl,
          color: dto.color,
          bio: dto.bio,
          isActive: dto.isActive,
          sortOrder: dto.sortOrder,
        },
      });

      if (dto.serviceIds) {
        await tx.barberStaffService.deleteMany({ where: { staffId: id } });
        await tx.barberStaffService.createMany({
          data: dto.serviceIds.map((serviceId) => ({ staffId: id, serviceId })),
          skipDuplicates: true,
        });
      }

      return staff;
    });
  }

  async deleteStaff(ctx: TenantContext, id: string) {
    await this.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    await this.prisma.barberStaff.update({
      where: { id },
      data: { isActive: false },
    });
    return { ok: true };
  }

  async listCustomers(ctx: TenantContext) {
    await this.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberCustomer.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      orderBy: [{ name: 'asc' }],
    });
  }

  async createCustomer(ctx: TenantContext, dto: CreateBarberCustomerDto) {
    await this.assertBarberTenant(ctx.tenantId);
    return this.prisma.barberCustomer.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        phone: dto.phone,
        email: dto.email,
        notes: dto.notes,
        tags: dto.tags ?? [],
      },
    });
  }

  async updateCustomer(
    ctx: TenantContext,
    id: string,
    dto: UpdateBarberCustomerDto,
  ) {
    await this.assertScopedRecord('barberCustomer', ctx, id, 'Customer');
    return this.prisma.barberCustomer.update({
      where: { id },
      data: dto,
    });
  }

  async listAppointments(ctx: TenantContext) {
    await this.assertBarberTenant(ctx.tenantId);
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
    await this.assertScopedRecord('barberAppointment', ctx, id, 'Appointment');
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
    await this.assertScopedRecord('barberAppointment', ctx, id, 'Appointment');
    return this.prisma.barberAppointment.update({
      where: { id },
      data: { status: 'CANCELLED', cancelReason: dto.reason },
      include: { customer: true, service: true, staff: true },
    });
  }

  private async ensureSettings(ctx: TenantContext) {
    await this.assertBarberTenant(ctx.tenantId);

    const existing = await this.prisma.barberSettings.findUnique({
      where: { branchId: ctx.branchId },
      include: {
        tenant: { select: { id: true, name: true, plan: true } },
        branch: { select: { id: true, name: true, address: true } },
      },
    });
    if (existing) return existing;

    const [tenant, branch] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { id: true, name: true, plan: true },
      }),
      this.prisma.branch.findUniqueOrThrow({
        where: { id: ctx.branchId },
        select: { id: true, name: true, address: true },
      }),
    ]);

    const bookingSlug = await this.nextAvailableBookingSlug(
      this.slugify(tenant.name),
    );

    return this.prisma.barberSettings.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        bookingSlug,
        city: branch.address?.includes('Bogot') ? 'Bogota' : undefined,
        heroTitle: tenant.name,
        heroDescription: 'Reserva tu cita online',
      },
      include: {
        tenant: { select: { id: true, name: true, plan: true } },
        branch: { select: { id: true, name: true, address: true } },
      },
    });
  }

  private toSettingsDto(settings: {
    id: string;
    tenantId: string;
    branchId: string;
    phone: string | null;
    city: string | null;
    timezone: string;
    currency: string;
    logoUrl: string | null;
    bookingSlug: string;
    onlineBookingEnabled: boolean;
    whatsappEnabled: boolean;
    loyaltyEnabled: boolean;
    themeTemplateId: string;
    themePrimaryColor: string;
    themeAccentColor: string;
    themeLogoMode: string | null;
    themeLogoImageUrl: string | null;
    themeBannerImageUrl: string | null;
    heroTitle: string | null;
    heroDescription: string | null;
    createdAt: Date;
    updatedAt: Date;
    tenant?: { id: string; name: string; plan: string };
    branch?: { id: string; name: string; address: string | null };
  }) {
    return {
      id: settings.id,
      tenantId: settings.tenantId,
      branchId: settings.branchId,
      business: {
        name: settings.tenant?.name,
        branchName: settings.branch?.name,
        address: settings.branch?.address,
        city: settings.city,
        phone: settings.phone,
        plan: settings.tenant?.plan,
      },
      booking: {
        slug: settings.bookingSlug,
        onlineBookingEnabled: settings.onlineBookingEnabled,
      },
      integrations: {
        whatsappEnabled: settings.whatsappEnabled,
        loyaltyEnabled: settings.loyaltyEnabled,
      },
      locale: {
        timezone: settings.timezone,
        currency: settings.currency,
      },
      logoUrl: settings.logoUrl,
      theme: {
        templateId: settings.themeTemplateId,
        primaryColor: settings.themePrimaryColor,
        accentColor: settings.themeAccentColor,
        logoMode: settings.themeLogoMode,
        logoImageUrl: settings.themeLogoImageUrl,
        bannerImageUrl: settings.themeBannerImageUrl,
        heroTitle: settings.heroTitle,
        heroDescription: settings.heroDescription,
      },
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }

  private async assertBarberTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { vertical: { select: { code: true } } },
    });
    if (tenant?.vertical?.code !== 'barber') {
      throw new BadRequestException('Tenant is not a barber vertical');
    }
  }

  private async assertScopedRecord(
    model:
      | 'barberAppointment'
      | 'barberCustomer'
      | 'barberService'
      | 'barberStaff',
    ctx: TenantContext,
    id: string,
    label: string,
  ) {
    const record =
      model === 'barberAppointment'
        ? await this.prisma.barberAppointment.findUnique({
            where: { id },
            select: { tenantId: true, branchId: true },
          })
        : model === 'barberCustomer'
          ? await this.prisma.barberCustomer.findUnique({
              where: { id },
              select: { tenantId: true, branchId: true },
            })
          : model === 'barberService'
            ? await this.prisma.barberService.findUnique({
                where: { id },
                select: { tenantId: true, branchId: true },
              })
            : await this.prisma.barberStaff.findUnique({
                where: { id },
                select: { tenantId: true, branchId: true },
              });
    if (
      !record ||
      record.tenantId !== ctx.tenantId ||
      record.branchId !== ctx.branchId
    ) {
      throw new NotFoundException(`${label} ${id} not found`);
    }
  }

  private async assertServicesBelongToBranch(
    ctx: TenantContext,
    serviceIds: string[],
  ) {
    if (serviceIds.length === 0) return;
    const services = await this.prisma.barberService.findMany({
      where: {
        id: { in: serviceIds },
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      select: { id: true },
    });
    if (services.length !== serviceIds.length) {
      throw new BadRequestException(
        'Some serviceIds do not belong to this branch',
      );
    }
  }

  private async assertAppointmentRelations(
    ctx: TenantContext,
    ids: { customerId?: string; serviceId?: string; staffId?: string },
  ) {
    await Promise.all([
      ids.customerId
        ? this.assertScopedRecord(
            'barberCustomer',
            ctx,
            ids.customerId,
            'Customer',
          )
        : Promise.resolve(),
      ids.serviceId
        ? this.assertScopedRecord(
            'barberService',
            ctx,
            ids.serviceId,
            'Service',
          )
        : Promise.resolve(),
      ids.staffId
        ? this.assertScopedRecord('barberStaff', ctx, ids.staffId, 'Staff')
        : Promise.resolve(),
    ]);
  }

  private async assertBookingSlugAvailable(slug: string, tenantId: string) {
    if (RESERVED_BOOKING_SLUGS.has(slug)) {
      throw new BadRequestException({
        code: 'BOOKING_SLUG_RESERVED',
        message: `Booking slug is reserved: ${slug}`,
      });
    }

    const existing = await this.prisma.barberSettings.findUnique({
      where: { bookingSlug: slug },
      select: { tenantId: true },
    });
    if (existing && existing.tenantId !== tenantId) {
      throw new ConflictException({
        code: 'BOOKING_SLUG_TAKEN',
        message: `Booking slug is already taken: ${slug}`,
      });
    }
  }

  private async nextAvailableBookingSlug(baseSlug: string) {
    let candidate = baseSlug || 'barber';
    if (RESERVED_BOOKING_SLUGS.has(candidate)) candidate = `${candidate}-1`;

    for (let index = 0; index < 100; index += 1) {
      const slug = index === 0 ? candidate : `${candidate}-${index + 1}`;
      const existing = await this.prisma.barberSettings.findUnique({
        where: { bookingSlug: slug },
        select: { id: true },
      });
      if (!existing && !RESERVED_BOOKING_SLUGS.has(slug)) return slug;
    }

    throw new ConflictException({
      code: 'BOOKING_SLUG_TAKEN',
      message: 'Could not generate available booking slug',
    });
  }

  private slugify(value: string) {
    return value
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 50);
  }
}
