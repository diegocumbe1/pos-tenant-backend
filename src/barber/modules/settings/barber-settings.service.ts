import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  assertBookingSlugAvailable,
  nextAvailableBookingSlug,
  slugify,
} from '../../shared/barber-slug';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import { resolvePublicBookingCopy } from '../../shared/public-booking-copy';
import {
  BarberGalleryItemDto,
  BarberStatDto,
  UpdateBarberSettingsDto,
} from './dto/barber-settings.dto';

const DAY_OF_WEEK_ORDER = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
] as const;

type DayOfWeek = (typeof DAY_OF_WEEK_ORDER)[number];
type TimeRange = { start: string; end: string };
type BusinessHours = Record<DayOfWeek, TimeRange[]>;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

// Horario por defecto cuando el negocio aún no configuró nada (L–V 8–12/14–18,
// Sáb 8–12, Dom cerrado). Coincide con el default del frontend.
const DEFAULT_BUSINESS_HOURS: BusinessHours = {
  monday: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  tuesday: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  wednesday: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  thursday: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  friday: [{ start: '08:00', end: '12:00' }, { start: '14:00', end: '18:00' }],
  saturday: [{ start: '08:00', end: '12:00' }],
  sunday: [],
};

const hhmmToMinutes = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

type SettingsWithRelations = Prisma.BarberSettingsGetPayload<{
  include: {
    tenant: { select: { id: true; name: true; plan: true } };
    branch: { select: { id: true; name: true; address: true } };
  };
}>;

@Injectable()
export class BarberSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
  ) {}

  async getSettings(ctx: TenantContext) {
    const settings = await this.ensureSettings(ctx);
    return this.toSettingsDto(settings);
  }

  async updateSettings(ctx: TenantContext, dto: UpdateBarberSettingsDto) {
    const current = await this.ensureSettings(ctx);

    if (dto.bookingSlug && dto.bookingSlug !== current.bookingSlug) {
      await assertBookingSlugAvailable(this.prisma, dto.bookingSlug, ctx.tenantId);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.business?.businessName) {
        await tx.tenant.update({
          where: { id: ctx.tenantId },
          data: { name: dto.business.businessName },
        });
      }

      if (
        dto.business?.branchName !== undefined ||
        dto.business?.address !== undefined
      ) {
        await tx.branch.update({
          where: { id: ctx.branchId },
          data: {
            name: dto.business?.branchName,
            address: dto.business?.address,
          },
        });
      }

      return tx.barberSettings.update({
        where: { branchId: ctx.branchId },
        data: {
          phone: dto.business?.phone,
          city: dto.business?.city,
          neighborhood: dto.business?.neighborhood,
          whatsapp: dto.business?.whatsapp,
          timezone: dto.timezone,
          currency: dto.currency,
          logoUrl: dto.logoUrl,
          bookingSlug: dto.bookingSlug,
          bookingMode: dto.booking?.bookingMode,
          publicBookingCopy:
            dto.booking?.publicCopy === undefined
              ? undefined
              : ({
                  ...this.toPublicCopyRecord(current.publicBookingCopy),
                  ...dto.booking.publicCopy,
                } as Prisma.InputJsonValue),
          businessHours: dto.booking?.businessHours
            ? (this.sanitizeBusinessHours(
                dto.booking.businessHours,
              ) as unknown as Prisma.InputJsonValue)
            : undefined,
          // Acepta el flag tanto anidado (UI nueva) como plano (compatibilidad).
          onlineBookingEnabled:
            dto.booking?.onlineBookingEnabled ?? dto.onlineBookingEnabled,
          publicProfilePublished: dto.publicProfilePublished,
          whatsappEnabled: dto.whatsappEnabled,
          loyaltyEnabled: dto.loyaltyEnabled,
          themeTemplateId: dto.theme?.templateId,
          themePrimaryColor: dto.theme?.primaryColor,
          themeAccentColor: dto.theme?.accentColor,
          themeInkColor: dto.theme?.inkColor,
          themeLogoMode: dto.theme?.logoMode,
          themeLogoImageUrl: dto.theme?.logoImageUrl,
          themeBannerImageUrl: dto.theme?.bannerImageUrl,
          heroImageUrl: dto.theme?.heroImageUrl,
          heroTitle: dto.theme?.heroTitle,
          heroDescription: dto.theme?.heroDescription,
          shortName: dto.brochure?.shortName,
          tagline: dto.brochure?.tagline,
          eyebrow: dto.brochure?.eyebrow,
          description: dto.brochure?.description,
          highlights: dto.brochure?.highlights,
          stats: dto.stats
            ? (dto.stats as unknown as Prisma.InputJsonValue)
            : undefined,
          galleryImages: dto.gallery
            ? (dto.gallery as unknown as Prisma.InputJsonValue)
            : undefined,
          socialInstagram: dto.socials?.instagram,
          socialFacebook: dto.socials?.facebook,
          socialTiktok: dto.socials?.tiktok,
          socialWebsite: dto.socials?.website,
          instagramProfileUrl: dto.instagram?.profileUrl,
          instagramPosts: dto.instagram?.posts,
        },
        include: this.includeRelations(),
      });
    });

    return this.toSettingsDto(updated);
  }

  async ensureSettings(ctx: TenantContext): Promise<SettingsWithRelations> {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);

    const existing = await this.prisma.barberSettings.findUnique({
      where: { branchId: ctx.branchId },
      include: this.includeRelations(),
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

    const bookingSlug = await nextAvailableBookingSlug(
      this.prisma,
      slugify(tenant.name),
    );

    return this.prisma.barberSettings.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        bookingSlug,
        city: branch.address?.includes('Bogot') ? 'Bogota' : undefined,
        heroTitle: tenant.name,
        heroDescription: 'Reserva tu cita online',
        description: 'Tu barberia favorita, reserva online sin filas.',
      },
      include: this.includeRelations(),
    });
  }

  private includeRelations() {
    return {
      tenant: { select: { id: true, name: true, plan: true } },
      branch: { select: { id: true, name: true, address: true } },
    } as const;
  }

  private toSettingsDto(settings: SettingsWithRelations) {
    return {
      id: settings.id,
      tenantId: settings.tenantId,
      branchId: settings.branchId,
      business: {
        name: settings.tenant?.name,
        branchName: settings.branch?.name,
        address: settings.branch?.address,
        neighborhood: settings.neighborhood,
        city: settings.city,
        phone: settings.phone,
        whatsapp: settings.whatsapp,
        plan: settings.tenant?.plan,
      },
      booking: {
        slug: settings.bookingSlug,
        bookingMode:
          settings.bookingMode === 'resources' ? 'resources' : 'services',
        publicCopy: resolvePublicBookingCopy(
          settings.bookingMode,
          settings.publicBookingCopy,
        ),
        businessHours: this.resolveBusinessHours(settings.businessHours),
        onlineBookingEnabled: settings.onlineBookingEnabled,
        publicProfilePublished: settings.publicProfilePublished,
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
        inkColor: settings.themeInkColor,
        logoMode: settings.themeLogoMode,
        logoImageUrl: settings.themeLogoImageUrl,
        bannerImageUrl: settings.themeBannerImageUrl,
        heroImageUrl: settings.heroImageUrl,
        heroTitle: settings.heroTitle,
        heroDescription: settings.heroDescription,
      },
      brochure: {
        shortName: settings.shortName,
        tagline: settings.tagline,
        eyebrow: settings.eyebrow,
        description: settings.description,
        highlights: settings.highlights,
      },
      stats: this.coerceStats(settings.stats),
      gallery: this.coerceGallery(settings.galleryImages),
      socials: {
        instagram: settings.socialInstagram,
        facebook: settings.socialFacebook,
        tiktok: settings.socialTiktok,
        website: settings.socialWebsite,
      },
      instagram: {
        profileUrl: settings.instagramProfileUrl,
        posts: settings.instagramPosts,
      },
      createdAt: settings.createdAt,
      updatedAt: settings.updatedAt,
    };
  }

  // Normaliza el input del cliente: garantiza los 7 días, descarta rangos
  // inválidos (formato HH:MM y fin > inicio) y ordena por hora de inicio.
  private sanitizeBusinessHours(raw: Record<string, unknown>): BusinessHours {
    return DAY_OF_WEEK_ORDER.reduce((acc, day) => {
      const ranges = Array.isArray(raw?.[day]) ? (raw[day] as unknown[]) : [];
      acc[day] = ranges
        .filter(
          (r): r is TimeRange =>
            !!r &&
            typeof r === 'object' &&
            typeof (r as TimeRange).start === 'string' &&
            typeof (r as TimeRange).end === 'string' &&
            HHMM.test((r as TimeRange).start) &&
            HHMM.test((r as TimeRange).end) &&
            hhmmToMinutes((r as TimeRange).end) >
              hhmmToMinutes((r as TimeRange).start),
        )
        .map((r) => ({ start: r.start, end: r.end }))
        .sort((a, b) => hhmmToMinutes(a.start) - hhmmToMinutes(b.start));
      return acc;
    }, {} as BusinessHours);
  }

  // Lo que persistimos puede ser {} (default de columna). En ese caso devolvemos
  // el horario por defecto para que la UI no muestre todo cerrado.
  private resolveBusinessHours(raw: Prisma.JsonValue): BusinessHours {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      return DEFAULT_BUSINESS_HOURS;
    }
    const hasAnyDay = DAY_OF_WEEK_ORDER.some((day) =>
      Array.isArray((raw as Record<string, unknown>)[day]),
    );
    if (!hasAnyDay) return DEFAULT_BUSINESS_HOURS;
    return this.sanitizeBusinessHours(raw as Record<string, unknown>);
  }

  private toPublicCopyRecord(raw: Prisma.JsonValue): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    return raw as Record<string, unknown>;
  }

  private coerceStats(raw: Prisma.JsonValue): BarberStatDto[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry): entry is { label: string; value: string } =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).label === 'string' &&
          typeof (entry as Record<string, unknown>).value === 'string',
      )
      .map((entry) => ({ label: entry.label, value: entry.value }));
  }

  private coerceGallery(raw: Prisma.JsonValue): BarberGalleryItemDto[] {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter(
        (entry): entry is { title: string; imageUrl: string } =>
          !!entry &&
          typeof entry === 'object' &&
          typeof (entry as Record<string, unknown>).title === 'string' &&
          typeof (entry as Record<string, unknown>).imageUrl === 'string',
      )
      .map((entry) => ({ title: entry.title, imageUrl: entry.imageUrl }));
  }
}
