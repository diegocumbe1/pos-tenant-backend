import { Prisma } from '@prisma/client';
import { TenantContext } from '../../auth/types/tenant-context.interface';

/**
 * A single seed section created when a brand-new public site is provisioned for
 * a tenant. Shape matches `PublicSiteSection` create input (minus `siteId`).
 */
export type SiteSectionSeed = {
  type: string;
  sortOrder: number;
  isVisible?: boolean;
  width?: string;
  density?: string;
  title?: string | null;
  eyebrow?: string | null;
  subtitle?: string | null;
  body?: string | null;
  ctaLabel?: string | null;
  ctaAction?: string | null;
  settings?: Prisma.InputJsonValue;
};

/**
 * Initial values used to provision a public site the first time it is opened in
 * the editor. Returned by each vertical strategy from its own data sources.
 */
export type SiteSeed = {
  slug: string;
  status: 'draft' | 'published';
  seoTitle?: string | null;
  seoDescription?: string | null;
  ogImageUrl?: string | null;
  themePrimary?: string;
  themeAccent?: string;
  themeInk?: string;
  shortName?: string | null;
  neighborhood?: string | null;
  city?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  sections: SiteSectionSeed[];
};

export type SiteSeedContext = {
  tenant: { id: string; name: string };
  branch: { id: string; name: string; address: string | null };
};

/** Structural view of the editor update payload (avoids importing DTO classes). */
export type SiteUpdateInput = {
  slug?: string;
  status?: 'draft' | 'published';
  business?: {
    name?: string;
    shortName?: string;
    neighborhood?: string;
    city?: string;
    phone?: string;
    whatsapp?: string;
  };
  theme?: { primary?: string; accent?: string; ink?: string };
};

/**
 * Minimal view of a public site needed to validate it before publishing.
 */
export type PublishableSite = {
  id: string;
  branchId: string;
  slug: string;
  phone: string | null;
  whatsapp: string | null;
  ogImageUrl: string | null;
  tenant: { name: string };
  sections: {
    type: string;
    isVisible: boolean;
    title: string | null;
    subtitle: string | null;
  }[];
  assets: { kind: string; isVisible: boolean }[];
};

/** A product group of the public catalog, as rendered by the site. */
export type PublicCatalogCategory = {
  id: string;
  name: string;
  emoji: string | null;
  products: Array<{
    id: string;
    name: string;
    description: string | null;
    priceCOP: number;
    emoji: string | null;
    imageUrls: string[];
    /**
     * Disponibilidad publicada. `stock` es null cuando el ítem no controla
     * existencias (servicios): siempre se puede pedir. Nunca se expone costo
     * ni margen — el sitio es público.
     */
    stock: number | null;
    inStock: boolean;
  }>;
};

/**
 * Per-vertical behavior for the shared public-site builder. The core
 * `PublicSiteService` stays vertical-agnostic and delegates every business rule
 * that differs between verticals (barber bookings vs. retail catalog) here.
 */
export interface VerticalSiteStrategy {
  /** BusinessVertical.code this strategy serves (e.g. 'barber', 'retail'). */
  readonly verticalCode: string;

  /** Build the initial site + default sections when first provisioned. */
  buildSiteSeed(ctx: TenantContext, seed: SiteSeedContext): Promise<SiteSeed>;

  /** Sync vertical-specific settings when the site is edited (inside a tx). */
  syncOnUpdate(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
    dto: SiteUpdateInput,
  ): Promise<void>;

  /** Side-effects when publishing (e.g. flip a legacy "published" flag). */
  syncOnPublish(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
  ): Promise<void>;

  /** Side-effects when unpublishing. */
  syncOnUnpublish(
    tx: Prisma.TransactionClient,
    ctx: TenantContext,
  ): Promise<void>;

  /** Return the list of missing requirements that block publishing. */
  collectMissing(site: PublishableSite): Promise<string[]>;

  /**
   * Live catalog rendered by the site's `catalog` section. Each vertical reads
   * its own tables (retail → retail_products); verticals without a sellable
   * catalog return an empty list.
   */
  buildPublicCatalog(site: {
    tenantId: string;
    branchId: string;
  }): Promise<PublicCatalogCategory[]>;

  /** Slugs that may not be used as a public-site slug for this vertical. */
  reservedSlugs(): Set<string>;

  /**
   * Extra slug-collision sources outside the public_sites table
   * (barber also reserves booking slugs). Return true if `slug` collides.
   */
  extraSlugConflict(slug: string, ownerBranchId?: string): Promise<boolean>;
}
