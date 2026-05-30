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
import {
  BarberGalleryItemDto,
  BarberStatDto,
  UpdateBarberSettingsDto,
} from './dto/barber-settings.dto';

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
          onlineBookingEnabled: dto.onlineBookingEnabled,
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
