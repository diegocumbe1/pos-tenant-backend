import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantContext } from '../../auth/types/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { RESERVED_BOOKING_SLUGS, slugify } from '../../barber/shared/barber-slug';
import { resolvePublicBookingCopy } from '../../barber/shared/public-booking-copy';
import {
  PublishableSite,
  SiteSeed,
  SiteSeedContext,
  SiteUpdateInput,
  VerticalSiteStrategy,
} from './vertical-site-strategy';

/**
 * Barber vertical: a booking-first public site backed by `BarberSettings` and
 * `BarberService`. Preserves the original (pre-generalization) behavior.
 */
@Injectable()
export class BarberSiteStrategy implements VerticalSiteStrategy {
  readonly verticalCode = 'barber';

  constructor(private readonly prisma: PrismaService) {}

  async buildSiteSeed(
    ctx: TenantContext,
    seed: SiteSeedContext,
  ): Promise<SiteSeed> {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { branchId: ctx.branchId },
    });
    const publicCopy = resolvePublicBookingCopy(
      settings?.bookingMode,
      settings?.publicBookingCopy,
    );

    return {
      slug: settings?.bookingSlug ?? slugify(seed.tenant.name),
      status: settings?.publicProfilePublished ? 'published' : 'draft',
      seoTitle: settings?.heroTitle ?? seed.tenant.name,
      seoDescription:
        settings?.description ??
        settings?.heroDescription ??
        `${publicCopy.primaryCta} online`,
      ogImageUrl: settings?.heroImageUrl ?? settings?.themeBannerImageUrl,
      themePrimary: settings?.themePrimaryColor ?? undefined,
      themeAccent: settings?.themeAccentColor ?? undefined,
      themeInk: settings?.themeInkColor ?? undefined,
      shortName: settings?.shortName,
      neighborhood: settings?.neighborhood,
      city: settings?.city,
      phone: settings?.phone,
      whatsapp: settings?.whatsapp,
      sections: [
        {
          type: 'hero',
          sortOrder: 10,
          width: 'full',
          density: 'immersive',
          title: settings?.heroTitle ?? seed.tenant.name,
          eyebrow: settings?.eyebrow,
          subtitle:
            settings?.heroDescription ?? `${publicCopy.primaryCta} online`,
          body: settings?.description,
          ctaLabel: publicCopy.primaryCta,
          ctaAction: 'open_booking',
        },
        {
          type: 'services',
          sortOrder: 20,
          title:
            publicCopy.itemPlural.charAt(0).toUpperCase() +
            publicCopy.itemPlural.slice(1),
          subtitle: publicCopy.selectionPrompt,
          ctaLabel: publicCopy.primaryCta,
          ctaAction: 'open_booking',
          settings: { initialVisible: 6 },
        },
        { type: 'gallery', sortOrder: 30, width: 'wide', title: 'Galeria' },
        {
          type: 'instagram',
          isVisible: Boolean(settings?.instagramProfileUrl),
          sortOrder: 40,
          title: 'Instagram',
        },
        {
          type: 'booking_cta',
          sortOrder: 50,
          title:
            publicCopy.bookingNoun.charAt(0).toUpperCase() +
            publicCopy.bookingNoun.slice(1),
          subtitle: publicCopy.schedulePrompt,
          ctaLabel: publicCopy.primaryCta,
          ctaAction: 'open_booking',
        },
        {
          type: 'contact',
          sortOrder: 60,
          density: 'compact',
          title: 'Contacto',
        },
      ],
    };
  }

  async syncOnUpdate(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    dto: SiteUpdateInput,
  ): Promise<void> {
    await tx.barberSettings.update({
      where: { branchId: ctx.branchId },
      data: {
        bookingSlug: dto.slug,
        publicProfilePublished: dto.status === 'draft' ? false : undefined,
        shortName: dto.business?.shortName,
        neighborhood: dto.business?.neighborhood,
        city: dto.business?.city,
        phone: dto.business?.phone,
        whatsapp: dto.business?.whatsapp,
        themePrimaryColor: dto.theme?.primary,
        themeAccentColor: dto.theme?.accent,
        themeInkColor: dto.theme?.ink,
      },
    });
  }

  async syncOnPublish(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
  ): Promise<void> {
    await tx.barberSettings.update({
      where: { branchId: ctx.branchId },
      data: { publicProfilePublished: true },
    });
  }

  async syncOnUnpublish(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
  ): Promise<void> {
    await tx.barberSettings.update({
      where: { branchId: ctx.branchId },
      data: { publicProfilePublished: false },
    });
  }

  async collectMissing(site: PublishableSite): Promise<string[]> {
    const hero = site.sections.find(
      (section) => section.type === 'hero' && section.isVisible,
    );
    const hasHeroImage =
      site.assets.some((asset) => asset.kind === 'hero' && asset.isVisible) ||
      Boolean(site.ogImageUrl);
    const activeServices = await this.prisma.barberService.count({
      where: { branchId: site.branchId, isActive: true },
    });

    const missing: string[] = [];
    if (!site.slug) missing.push('slug');
    if (!site.tenant.name) missing.push('business name');
    if (!site.phone && !site.whatsapp) missing.push('phone or whatsapp');
    if (activeServices < 1) missing.push('at least one active service');
    if (!hero?.title || !hero?.subtitle) missing.push('hero title/subtitle');
    if (!hasHeroImage) missing.push('hero image or og image');
    return missing;
  }

  reservedSlugs(): Set<string> {
    return RESERVED_BOOKING_SLUGS;
  }

  async extraSlugConflict(slug: string, ownerBranchId?: string): Promise<boolean> {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { bookingSlug: slug },
      select: { branchId: true },
    });
    if (!settings) return false;
    return settings.branchId !== ownerBranchId;
  }
}
