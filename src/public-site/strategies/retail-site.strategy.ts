import { Injectable } from '@nestjs/common';
import { TenantContext } from '../../auth/types/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { slugify } from '../../barber/shared/barber-slug';
import {
  PublicCatalogCategory,
  PublishableSite,
  SiteSeed,
  SiteSeedContext,
  VerticalSiteStrategy,
} from './vertical-site-strategy';

/** Reserved slugs for retail sites (avoid clashing with app/system routes). */
const RESERVED_RETAIL_SLUGS = new Set([
  'admin',
  'api',
  'app',
  'public',
  'sites',
  'login',
  'dashboard',
]);

/**
 * Retail vertical (e.g. a phone shop like JIMCELL or a case store like CaseHub):
 * a catalog-first public site whose primary action is "order via WhatsApp". It
 * has no bookings and no BarberSettings — its catalog comes from the vertical's
 * own `RetailProduct` table, never from the restaurant `Product` table.
 */
@Injectable()
export class RetailSiteStrategy implements VerticalSiteStrategy {
  readonly verticalCode = 'retail';

  constructor(private readonly prisma: PrismaService) {}

  async buildSiteSeed(
    _ctx: TenantContext,
    seed: SiteSeedContext,
  ): Promise<SiteSeed> {
    return {
      slug: slugify(seed.tenant.name),
      status: 'draft',
      seoTitle: seed.tenant.name,
      seoDescription: `${seed.tenant.name} · Catálogo y pedidos por WhatsApp`,
      sections: [
        {
          type: 'hero',
          sortOrder: 10,
          width: 'full',
          density: 'immersive',
          title: seed.tenant.name,
          subtitle: 'Celulares, accesorios y servicio técnico.',
          ctaLabel: 'Pedir por WhatsApp',
          ctaAction: 'open_whatsapp',
        },
        {
          type: 'services',
          sortOrder: 20,
          title: 'Servicios',
          subtitle: 'Lo que hacemos por ti.',
        },
        {
          type: 'catalog',
          sortOrder: 30,
          width: 'wide',
          title: 'Catálogo',
          subtitle: 'Toca un producto para pedirlo por WhatsApp.',
          ctaLabel: 'Pedir por WhatsApp',
          ctaAction: 'open_whatsapp',
          settings: {
            source: 'branch',
            showPrices: true,
            groupByCategory: true,
          },
        },
        { type: 'gallery', sortOrder: 40, width: 'wide', title: 'Galería' },
        { type: 'instagram', sortOrder: 50, title: 'Instagram' },
        {
          type: 'contact',
          sortOrder: 60,
          density: 'compact',
          title: 'Contacto',
        },
      ],
    };
  }

  // Retail has no external settings table to keep in sync.
  async syncOnUpdate(): Promise<void> {}
  async syncOnPublish(): Promise<void> {}
  async syncOnUnpublish(): Promise<void> {}

  async collectMissing(site: PublishableSite): Promise<string[]> {
    const hero = site.sections.find(
      (section) => section.type === 'hero' && section.isVisible,
    );
    const hasHeroImage =
      site.assets.some((asset) => asset.kind === 'hero' && asset.isVisible) ||
      Boolean(site.ogImageUrl);
    const availableProducts = await this.prisma.retailProduct.count({
      where: {
        branchId: site.branchId,
        isActive: true,
        isPublished: true,
        deletedAt: null,
      },
    });

    const missing: string[] = [];
    if (!site.slug) missing.push('slug');
    if (!site.tenant.name) missing.push('business name');
    if (!site.whatsapp) missing.push('whatsapp number');
    if (availableProducts < 1) missing.push('at least one available product');
    if (!hero?.title || !hero?.subtitle) missing.push('hero title/subtitle');
    if (!hasHeroImage) missing.push('hero image or og image');
    return missing;
  }

  /**
   * Catálogo público: solo categorías visibles con productos activos y
   * publicados. Un producto agotado sigue apareciendo (se pide por WhatsApp);
   * lo que lo oculta es `isPublished=false`.
   */
  async buildPublicCatalog(site: {
    tenantId: string;
    branchId: string;
  }): Promise<PublicCatalogCategory[]> {
    const categories = await this.prisma.retailCategory.findMany({
      where: {
        tenantId: site.tenantId,
        branchId: site.branchId,
        isVisible: true,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        emoji: true,
        products: {
          where: { isActive: true, isPublished: true, deletedAt: null },
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          select: {
            id: true,
            name: true,
            description: true,
            priceCOP: true,
            emoji: true,
            imageUrls: true,
          },
        },
      },
    });
    return categories.filter((category) => category.products.length > 0);
  }

  reservedSlugs(): Set<string> {
    return RESERVED_RETAIL_SLUGS;
  }

  async extraSlugConflict(): Promise<boolean> {
    return false;
  }
}
