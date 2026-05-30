import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  CreatePublicAppointmentDto,
  PublicAvailabilityQueryDto,
} from './dto/public-appointment.dto';

type BrochureSettings = Prisma.BarberSettingsGetPayload<{
  include: {
    tenant: { select: { id: true; name: true } };
    branch: { select: { id: true; name: true; address: true } };
  };
}>;

const DEFAULT_DAY_START_MIN = 9 * 60; // 09:00
const DEFAULT_DAY_END_MIN = 19 * 60; // 19:00
const SLOT_STEP_MIN = 30;

@Injectable()
export class BarberPublicService {
  constructor(private readonly prisma: PrismaService) {}

  async getProfile(slug: string) {
    const settings = await this.loadPublishedSettings(slug);
    return this.toProfileDto(settings);
  }

  async listServices(branchId: string) {
    await this.assertBranchPublished(branchId);
    const services = await this.prisma.barberService.findMany({
      where: { branchId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return services.map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description ?? '',
      durationMin: service.durationMin,
      priceCOP: service.priceCOP,
      color: service.color,
    }));
  }

  async listSpecialists(branchId: string, serviceId?: string) {
    await this.assertBranchPublished(branchId);
    const staff = await this.prisma.barberStaff.findMany({
      where: {
        branchId,
        isActive: true,
        ...(serviceId ? { services: { some: { serviceId } } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { services: { select: { serviceId: true } } },
    });
    return staff.map((member) => ({
      id: member.id,
      name: member.name,
      bio: member.bio ?? '',
      avatarUrl: member.avatarUrl,
      color: member.color,
      serviceIds: member.services.map((s) => s.serviceId),
    }));
  }

  async getAvailability(branchId: string, query: PublicAvailabilityQueryDto) {
    await this.assertBranchPublished(branchId);

    const staff = await this.prisma.barberStaff.findUnique({
      where: { id: query.specialistId },
      select: { id: true, branchId: true, isActive: true },
    });
    if (!staff || staff.branchId !== branchId || !staff.isActive) {
      throw new NotFoundException('Specialist not found');
    }

    const durationMinutes = await this.resolveDuration(
      query.serviceId,
      query.durationMinutes,
      branchId,
    );

    const dayStart = this.parseDateBoundary(query.date, 0);
    const dayEnd = this.parseDateBoundary(query.date, 24 * 60);

    const appointments = await this.prisma.barberAppointment.findMany({
      where: {
        branchId,
        staffId: query.specialistId,
        status: { not: 'CANCELLED' },
        scheduledAt: { lt: dayEnd },
        scheduledEnd: { gt: dayStart },
      },
      select: { scheduledAt: true, scheduledEnd: true },
    });

    const slots: string[] = [];
    const now = Date.now();
    for (
      let minute = DEFAULT_DAY_START_MIN;
      minute + durationMinutes <= DEFAULT_DAY_END_MIN;
      minute += SLOT_STEP_MIN
    ) {
      const slotStart = this.parseDateBoundary(query.date, minute);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
      if (slotStart.getTime() <= now) continue;
      const overlaps = appointments.some(
        (apt) => apt.scheduledAt < slotEnd && apt.scheduledEnd > slotStart,
      );
      if (!overlaps) slots.push(slotStart.toISOString());
    }

    return {
      date: query.date,
      specialistId: query.specialistId,
      durationMinutes,
      slots,
    };
  }

  async createAppointment(branchId: string, dto: CreatePublicAppointmentDto) {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { branchId },
      select: {
        tenantId: true,
        branchId: true,
        publicProfilePublished: true,
        onlineBookingEnabled: true,
      },
    });
    if (!settings || !settings.publicProfilePublished) {
      throw new NotFoundException('Branch not found');
    }
    if (!settings.onlineBookingEnabled) {
      throw new ForbiddenException({
        code: 'ONLINE_BOOKING_DISABLED',
        message: 'Online booking is disabled for this branch',
      });
    }

    const [service, staff] = await Promise.all([
      this.prisma.barberService.findUnique({
        where: { id: dto.serviceId },
        select: {
          id: true,
          branchId: true,
          isActive: true,
          durationMin: true,
        },
      }),
      this.prisma.barberStaff.findUnique({
        where: { id: dto.specialistId },
        select: {
          id: true,
          branchId: true,
          isActive: true,
          services: { select: { serviceId: true } },
        },
      }),
    ]);

    if (!service || service.branchId !== branchId || !service.isActive) {
      throw new BadRequestException('Service is not available');
    }
    if (!staff || staff.branchId !== branchId || !staff.isActive) {
      throw new BadRequestException('Specialist is not available');
    }
    if (
      staff.services.length > 0 &&
      !staff.services.some((s) => s.serviceId === service.id)
    ) {
      throw new BadRequestException(
        'Specialist does not offer the requested service',
      );
    }

    const scheduledAt = new Date(dto.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid scheduledAt');
    }
    if (scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('scheduledAt must be in the future');
    }
    const scheduledEnd = new Date(
      scheduledAt.getTime() + service.durationMin * 60_000,
    );

    const conflict = await this.prisma.barberAppointment.findFirst({
      where: {
        branchId,
        staffId: staff.id,
        status: { not: 'CANCELLED' },
        scheduledAt: { lt: scheduledEnd },
        scheduledEnd: { gt: scheduledAt },
      },
      select: { id: true },
    });
    if (conflict) {
      throw new ConflictException({
        code: 'SLOT_TAKEN',
        message: 'The requested time slot is no longer available',
      });
    }

    const customer = await this.upsertCustomer(branchId, settings.tenantId, dto);

    const appointment = await this.prisma.barberAppointment.create({
      data: {
        tenantId: settings.tenantId,
        branchId,
        customerId: customer.id,
        serviceId: service.id,
        staffId: staff.id,
        scheduledAt,
        scheduledEnd,
        source: 'public',
        notes: dto.notes,
      },
      include: { service: true, staff: true },
    });

    return {
      id: appointment.id,
      status: appointment.status,
      scheduledAt: appointment.scheduledAt,
      scheduledEnd: appointment.scheduledEnd,
      service: {
        id: appointment.service.id,
        name: appointment.service.name,
        durationMin: appointment.service.durationMin,
        priceCOP: appointment.service.priceCOP,
      },
      specialist: {
        id: appointment.staff.id,
        name: appointment.staff.name,
      },
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
      },
    };
  }

  private async upsertCustomer(
    branchId: string,
    tenantId: string,
    dto: CreatePublicAppointmentDto,
  ) {
    const normalizedPhone = dto.customerPhone.trim();
    const existing = await this.prisma.barberCustomer.findUnique({
      where: { branchId_phone: { branchId, phone: normalizedPhone } },
    });
    if (existing) {
      if (
        existing.name !== dto.customerName ||
        (dto.customerEmail && existing.email !== dto.customerEmail)
      ) {
        return this.prisma.barberCustomer.update({
          where: { id: existing.id },
          data: {
            name: dto.customerName,
            email: dto.customerEmail ?? existing.email,
          },
        });
      }
      return existing;
    }
    return this.prisma.barberCustomer.create({
      data: {
        tenantId,
        branchId,
        name: dto.customerName,
        phone: normalizedPhone,
        email: dto.customerEmail,
      },
    });
  }

  private async loadPublishedSettings(slug: string): Promise<BrochureSettings> {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { bookingSlug: slug },
      include: {
        tenant: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, address: true } },
      },
    });
    if (!settings || !settings.publicProfilePublished) {
      throw new NotFoundException(`Profile ${slug} not found`);
    }
    return settings;
  }

  private async assertBranchPublished(branchId: string) {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { branchId },
      select: { publicProfilePublished: true },
    });
    if (!settings || !settings.publicProfilePublished) {
      throw new NotFoundException('Branch not found');
    }
  }

  private async resolveDuration(
    serviceId: string | undefined,
    fallback: number | undefined,
    branchId: string,
  ): Promise<number> {
    if (serviceId) {
      const service = await this.prisma.barberService.findUnique({
        where: { id: serviceId },
        select: { branchId: true, durationMin: true, isActive: true },
      });
      if (!service || service.branchId !== branchId || !service.isActive) {
        throw new BadRequestException('Service is not available');
      }
      return service.durationMin;
    }
    if (fallback && fallback > 0) return fallback;
    return 30;
  }

  private parseDateBoundary(date: string, minutesFromMidnight: number): Date {
    const [yearStr, monthStr, dayStr] = date.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    if (!year || !month || !day) {
      throw new BadRequestException('Invalid date');
    }
    return new Date(
      Date.UTC(year, month - 1, day, 0, minutesFromMidnight, 0, 0),
    );
  }

  private toProfileDto(settings: BrochureSettings) {
    const stats = this.coerceJsonArray(settings.stats, ['label', 'value']);
    const gallery = this.coerceJsonArray(settings.galleryImages, [
      'title',
      'imageUrl',
    ]);

    return {
      tenantId: settings.tenantId,
      branchId: settings.branchId,
      slug: settings.bookingSlug,
      name: settings.tenant?.name ?? settings.branch?.name ?? '',
      shortName: settings.shortName ?? '',
      tagline: settings.tagline ?? '',
      description: settings.description ?? '',
      eyebrow: settings.eyebrow ?? '',
      address: settings.branch?.address ?? '',
      neighborhood: settings.neighborhood ?? '',
      city: settings.city ?? '',
      phone: settings.phone ?? '',
      whatsapp: settings.whatsapp ?? '',
      heroImageUrl: settings.heroImageUrl ?? settings.themeBannerImageUrl ?? '',
      logoUrl: settings.themeLogoImageUrl ?? settings.logoUrl ?? '',
      theme: {
        primary: settings.themePrimaryColor,
        accent: settings.themeAccentColor,
        ink: settings.themeInkColor,
      },
      stats,
      highlights: settings.highlights ?? [],
      gallery,
      socials: {
        instagram: settings.socialInstagram ?? '',
        facebook: settings.socialFacebook ?? '',
        tiktok: settings.socialTiktok ?? '',
        website: settings.socialWebsite ?? '',
      },
      instagram: {
        profileUrl: settings.instagramProfileUrl ?? '',
        posts: settings.instagramPosts ?? [],
      },
      onlineBookingEnabled: settings.onlineBookingEnabled,
    };
  }

  private coerceJsonArray<K extends string>(
    raw: Prisma.JsonValue,
    fields: K[],
  ): Array<Record<K, string>> {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is Record<K, string> => {
        if (!entry || typeof entry !== 'object') return false;
        const record = entry as Record<string, unknown>;
        return fields.every((field) => typeof record[field] === 'string');
      })
      .map((entry) => {
        const out = {} as Record<K, string>;
        for (const field of fields) {
          out[field] = entry[field];
        }
        return out;
      });
  }
}
