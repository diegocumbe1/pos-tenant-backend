import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ImageKind,
  ImageUploadService,
  UploadedImageFile,
} from '../../../assets/image-upload.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { SupabaseService } from '../../../supabase/supabase.service';
import { slugify } from '../../shared/barber-slug';
import { VerticalSiteStrategy } from '../../../public-site/strategies/vertical-site-strategy';
import { VerticalSiteStrategyResolver } from '../../../public-site/strategies/vertical-site-strategy.resolver';
import {
  CreatePublicSiteAssetFromUrlDto,
  PublicSiteHighlightDto,
  PublicSiteInstagramPostDto,
  PublicSiteSectionDto,
  PublicSiteSocialLinkDto,
  PublicSiteStatDto,
  ReplacePublicSiteHighlightsDto,
  ReplacePublicSiteInstagramDto,
  ReplacePublicSiteSectionsDto,
  ReplacePublicSiteSocialsDto,
  ReplacePublicSiteStatsDto,
  UpdatePublicSiteAssetDto,
  UpdatePublicSiteDto,
  UploadPublicSiteAssetDto,
} from './dto/barber-public-site.dto';

type UploadedFile = UploadedImageFile;

type DownloadedRemoteImage = {
  buffer: Buffer;
  contentType?: string;
  sizeBytes: number;
};

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const EXTERNAL_IMAGE_DOWNLOAD_TIMEOUT_MS = 8_000;
const PUBLIC_SITE_TRANSACTION_OPTIONS = {
  maxWait: 10_000,
  timeout: 20_000,
};

const publicSiteInclude = {
  tenant: {
    select: {
      id: true,
      name: true,
      deletedAt: true,
      vertical: { select: { code: true, isActive: true } },
    },
  },
  branch: { select: { id: true, name: true, address: true } },
  sections: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  assets: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  socialLinks: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  instagramPosts: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  stats: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
  highlights: { orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }] },
} satisfies Prisma.PublicSiteInclude;

type SiteWithRelations = Prisma.PublicSiteGetPayload<{
  include: typeof publicSiteInclude;
}>;
type SiteMutationTarget = Pick<SiteWithRelations, 'id' | 'slug' | 'status'>;

@Injectable()
export class PublicSiteService {
  private readonly logger = new Logger(PublicSiteService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly strategies: VerticalSiteStrategyResolver,
    private readonly imageUpload: ImageUploadService,
  ) {}

  async getAdminSite(ctx: TenantContext) {
    const site = await this.ensureSite(ctx);
    return this.toAdminResponse(site);
  }

  async getPreview(ctx: TenantContext) {
    return this.toDraftProfile(await this.ensureSite(ctx));
  }

  async updateSite(ctx: TenantContext, dto: UpdatePublicSiteDto) {
    const site = await this.ensureSiteForMutation(ctx);
    const strategy = await this.strategies.resolveForTenant(ctx.tenantId);
    const shouldPublish = dto.status === 'published';
    if (dto.slug && dto.slug !== site.slug) {
      await this.assertSlugAvailable(dto.slug, strategy, site.id, ctx.branchId);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      if (dto.business?.name) {
        await tx.tenant.update({
          where: { id: ctx.tenantId },
          data: { name: dto.business.name },
        });
      }
      if (dto.business?.address !== undefined) {
        await tx.branch.update({
          where: { id: ctx.branchId },
          data: { address: dto.business.address },
        });
      }

      const updatedSite = await tx.publicSite.update({
        where: { id: site.id },
        data: {
          slug: dto.slug,
          status: dto.status === 'draft' ? 'draft' : undefined,
          publishedAt: dto.status === 'draft' ? null : undefined,
          seoTitle: dto.seo?.title,
          seoDescription: dto.seo?.description,
          ogImageUrl: dto.seo?.ogImageUrl,
          themePrimary: dto.theme?.primary,
          themeAccent: dto.theme?.accent,
          themeInk: dto.theme?.ink,
          themeBackground: dto.theme?.background,
          themeSurface: dto.theme?.surface,
          themeRadius: dto.theme?.radius,
          themeSecondary: dto.theme?.secondary,
          themeMode: dto.theme?.mode,
          themeBackgroundType: dto.theme?.backgroundType,
          themeFontStyle: dto.theme?.fontStyle,
          themeLogoUrl: dto.theme?.logoUrl,
          themeFaviconUrl: dto.theme?.faviconUrl,
          themeWhatsapp:
            dto.theme?.whatsapp === undefined
              ? undefined
              : (dto.theme.whatsapp as unknown as Prisma.InputJsonValue),
          shortName: dto.business?.shortName,
          neighborhood: dto.business?.neighborhood,
          city: dto.business?.city,
          phone: dto.business?.phone,
          whatsapp: dto.business?.whatsapp,
        },
        select: { id: true },
      });

      await strategy.syncOnUpdate(tx, ctx, dto);

      return updatedSite;
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);

    if (shouldPublish) return this.publish(ctx);
    return this.toAdminResponse(await this.persistDraftPayload(updated.id));
  }

  async replaceSections(ctx: TenantContext, dto: ReplacePublicSiteSectionsDto) {
    const site = await this.ensureSiteForMutation(ctx);
    this.assertSectionRules(dto.sections);
    await this.assertSectionAssetIds(site.id, dto.sections);

    await this.prisma.$transaction(async (tx) => {
      await tx.publicSiteSection.deleteMany({ where: { siteId: site.id } });
      await tx.publicSiteSection.createMany({
        data: dto.sections.map((section) => ({
          siteId: site.id,
          type: section.type,
          isVisible: section.isVisible,
          sortOrder: section.sortOrder,
          width: section.width,
          density: section.density,
          title: section.title,
          eyebrow: section.eyebrow,
          subtitle: section.subtitle,
          body: section.body,
          ctaLabel: section.ctaLabel,
          ctaAction: section.ctaAction,
          ctaHref: section.ctaHref,
          assetIds: section.assetIds ?? [],
          settings: (section.settings ?? {}) as Prisma.InputJsonValue,
        })),
      });
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);

    return this.toAdminResponse(await this.persistDraftPayload(site.id));
  }

  async uploadAsset(
    ctx: TenantContext,
    dto: UploadPublicSiteAssetDto,
    file?: UploadedFile,
  ) {
    const site = await this.ensureSiteForMutation(ctx);
    const uploaded = await this.uploadFile(ctx, site.id, dto.kind, file);
    const asset = await this.prisma.publicSiteAsset.create({
      data: {
        siteId: site.id,
        kind: dto.kind,
        url: uploaded.publicUrl,
        path: uploaded.path,
        bucket: uploaded.bucket,
        alt: dto.alt,
        width: uploaded.width,
        height: uploaded.height,
        fit: dto.fit ?? 'cover',
        focalPoint: dto.focalPoint ?? 'center',
      },
    });

    await this.persistDraftPayload(site.id);
    return { asset: this.toAssetDto(asset) };
  }

  async createAssetFromUrl(
    ctx: TenantContext,
    dto: CreatePublicSiteAssetFromUrlDto,
  ) {
    const site = await this.ensureSiteForMutation(ctx);
    const downloaded = await this.downloadRemoteImage(dto.url);
    const uploaded = await this.uploadFile(ctx, site.id, dto.kind, {
      buffer: downloaded.buffer,
      mimetype: downloaded.contentType,
      size: downloaded.sizeBytes,
    });
    const asset = await this.prisma.publicSiteAsset.create({
      data: {
        siteId: site.id,
        kind: dto.kind,
        url: uploaded.publicUrl,
        path: uploaded.path,
        bucket: uploaded.bucket,
        alt: dto.alt,
        width: uploaded.width,
        height: uploaded.height,
        fit: dto.fit ?? 'cover',
        focalPoint: dto.focalPoint ?? 'center',
      },
    });

    await this.persistDraftPayload(site.id);
    return { asset: this.toAssetDto(asset) };
  }

  async updateAsset(
    ctx: TenantContext,
    assetId: string,
    dto: UpdatePublicSiteAssetDto,
    file?: UploadedFile,
  ) {
    const site = await this.ensureSiteForMutation(ctx);
    const current = await this.prisma.publicSiteAsset.findFirst({
      where: { id: assetId, siteId: site.id },
    });
    if (!current) throw new NotFoundException(`Asset ${assetId} not found`);

    const replacement = file?.buffer?.length
      ? await this.uploadFile(ctx, site.id, current.kind, file)
      : undefined;

    const updated = await this.prisma.publicSiteAsset.update({
      where: { id: current.id },
      data: {
        alt: dto.alt,
        fit: dto.fit,
        focalPoint: dto.focalPoint,
        isVisible: dto.isVisible,
        sortOrder: dto.sortOrder,
        url: replacement?.publicUrl,
        path: replacement?.path,
        bucket: replacement?.bucket,
        width: replacement?.width,
        height: replacement?.height,
      },
    });

    if (replacement && current.path) {
      await this.supabase.deletePublicAsset(current.path);
    }

    await this.persistDraftPayload(site.id);
    return { asset: this.toAssetDto(updated) };
  }

  async deleteAsset(ctx: TenantContext, assetId: string) {
    const site = await this.ensureSiteForMutation(ctx);
    const asset = await this.prisma.publicSiteAsset.findFirst({
      where: { id: assetId, siteId: site.id },
    });
    if (!asset) throw new NotFoundException(`Asset ${assetId} not found`);

    const referenced = await this.prisma.publicSiteSection.findFirst({
      where: { siteId: site.id, isVisible: true, assetIds: { has: assetId } },
      select: { id: true, type: true },
    });
    if (site.status === 'published' && referenced) {
      throw new BadRequestException({
        code: 'ASSET_IN_USE',
        message: `Asset is used by visible section ${referenced.type}`,
      });
    }

    await this.prisma.publicSiteAsset.delete({ where: { id: asset.id } });
    if (asset.path) await this.supabase.deletePublicAsset(asset.path);
    await this.persistDraftPayload(site.id);
    return { ok: true };
  }

  async replaceSocials(ctx: TenantContext, dto: ReplacePublicSiteSocialsDto) {
    const site = await this.ensureSiteForMutation(ctx);
    this.assertUnique(
      dto.socials.map((social) => social.provider),
      'provider',
    );
    dto.socials.forEach((social) =>
      this.assertSocialUrl(social.provider, social.url),
    );

    await this.prisma.$transaction(async (tx) => {
      await tx.publicSiteSocialLink.deleteMany({ where: { siteId: site.id } });
      await tx.publicSiteSocialLink.createMany({
        data: dto.socials.map((social) => ({
          siteId: site.id,
          provider: social.provider,
          label: social.label,
          url: social.url,
          isVisible: social.isVisible,
          sortOrder: social.sortOrder,
        })),
      });
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);

    return this.toAdminResponse(await this.persistDraftPayload(site.id));
  }

  async replaceInstagram(
    ctx: TenantContext,
    dto: ReplacePublicSiteInstagramDto,
  ) {
    const site = await this.ensureSiteForMutation(ctx);
    dto.posts.forEach((post) => this.assertInstagramUrl(post));

    await this.prisma.$transaction(async (tx) => {
      if (dto.profileUrl) {
        const existing = await tx.publicSiteSocialLink.findUnique({
          where: {
            siteId_provider: { siteId: site.id, provider: 'instagram' },
          },
        });
        if (existing) {
          await tx.publicSiteSocialLink.update({
            where: { id: existing.id },
            data: { url: dto.profileUrl, label: 'Instagram' },
          });
        } else {
          await tx.publicSiteSocialLink.create({
            data: {
              siteId: site.id,
              provider: 'instagram',
              label: 'Instagram',
              url: dto.profileUrl,
              sortOrder: 10,
            },
          });
        }
      }

      await tx.publicSiteInstagramPost.deleteMany({
        where: { siteId: site.id },
      });
      await tx.publicSiteInstagramPost.createMany({
        data: dto.posts.map((post) => ({
          siteId: site.id,
          url: post.url,
          kind: post.kind,
          isVisible: post.isVisible,
          sortOrder: post.sortOrder,
        })),
      });
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);

    return this.toAdminResponse(await this.persistDraftPayload(site.id));
  }

  async replaceStats(ctx: TenantContext, dto: ReplacePublicSiteStatsDto) {
    const site = await this.ensureSiteForMutation(ctx);
    await this.prisma.$transaction(async (tx) => {
      await tx.publicSiteStat.deleteMany({ where: { siteId: site.id } });
      await tx.publicSiteStat.createMany({
        data: dto.stats.map((stat) => this.toStatCreate(site.id, stat)),
      });
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);
    return this.toAdminResponse(await this.persistDraftPayload(site.id));
  }

  async replaceHighlights(
    ctx: TenantContext,
    dto: ReplacePublicSiteHighlightsDto,
  ) {
    const site = await this.ensureSiteForMutation(ctx);
    await this.prisma.$transaction(async (tx) => {
      await tx.publicSiteHighlight.deleteMany({ where: { siteId: site.id } });
      await tx.publicSiteHighlight.createMany({
        data: dto.highlights.map((highlight) =>
          this.toHighlightCreate(site.id, highlight),
        ),
      });
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);
    return this.toAdminResponse(await this.persistDraftPayload(site.id));
  }

  async publish(ctx: TenantContext) {
    const site = await this.ensureSite(ctx);
    const strategy = await this.strategies.resolveForTenant(ctx.tenantId);
    await this.assertPublishable(site, strategy);
    const draft = this.toDraftProfile(site);
    const publishedAt = new Date();
    const published = {
      ...draft,
      status: 'published',
      version: 'published',
      publishedAt: publishedAt.toISOString(),
    };
    await this.prisma.$transaction(async (tx) => {
      await tx.publicSite.update({
        where: { id: site.id },
        data: {
          status: 'published',
          publishedSlug: site.slug,
          publishedAt,
          publishedByUserId: ctx.userId,
          draftPayload: draft as Prisma.InputJsonValue,
          publishedPayload: published as Prisma.InputJsonValue,
        },
      });
      await strategy.syncOnPublish(tx, ctx);
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);
    return {
      status: 'published',
      published,
      publishedAt: publishedAt.toISOString(),
      hasUnpublishedChanges: false,
    };
  }

  async unpublish(ctx: TenantContext) {
    const site = await this.ensureSite(ctx);
    const strategy = await this.strategies.resolveForTenant(ctx.tenantId);
    await this.prisma.$transaction(async (tx) => {
      await tx.publicSite.update({
        where: { id: site.id },
        data: { status: 'draft', publishedAt: null },
      });
      await strategy.syncOnUnpublish(tx, ctx);
    }, PUBLIC_SITE_TRANSACTION_OPTIONS);
    return this.toAdminResponse(await this.persistDraftPayload(site.id));
  }

  async getPublicSiteBySlug(slug: string) {
    const site = await this.prisma.publicSite.findFirst({
      where: { publishedSlug: slug, status: 'published' },
      include: this.includeRelations(),
    });
    if (
      !site ||
      site.status !== 'published' ||
      site.tenant.deletedAt ||
      !this.strategies.supports(site.tenant.vertical?.code) ||
      !site.tenant.vertical?.isActive
    ) {
      throw new NotFoundException(`Site ${slug} not found`);
    }
    if (!site.publishedPayload) {
      this.logger.error(
        `Published barber public site ${site.id} has no publishedPayload`,
      );
      throw new NotFoundException(`Site ${slug} not found`);
    }
    return site.publishedPayload;
  }

  /**
   * Live catalog for a published site, grouped by category. Powers the retail
   * "catalog → order via WhatsApp" section. Prices are read live (not snapshot)
   * so the public site always reflects the current price list.
   */
  async getPublicCatalogBySlug(slug: string) {
    const site = await this.prisma.publicSite.findFirst({
      where: { publishedSlug: slug, status: 'published' },
      select: {
        tenantId: true,
        branchId: true,
        phone: true,
        whatsapp: true,
        tenant: {
          select: {
            name: true,
            deletedAt: true,
            vertical: { select: { code: true, isActive: true } },
          },
        },
      },
    });
    if (
      !site ||
      site.tenant.deletedAt ||
      !this.strategies.supports(site.tenant.vertical?.code) ||
      !site.tenant.vertical?.isActive
    ) {
      throw new NotFoundException(`Site ${slug} not found`);
    }

    const branchScope = [{ branchId: site.branchId }, { branchId: null }];
    const categories = await this.prisma.productCategory.findMany({
      where: { tenantId: site.tenantId, OR: branchScope },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        emoji: true,
        products: {
          where: { isAvailable: true, deletedAt: null, OR: branchScope },
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

    return {
      business: {
        name: site.tenant.name,
        phone: site.phone,
        whatsapp: site.whatsapp,
      },
      categories: categories
        .filter((category) => category.products.length > 0)
        .map((category) => ({
          id: category.id,
          name: category.name,
          emoji: category.emoji,
          products: category.products,
        })),
    };
  }

  /**
   * Live service list for a published site (barber vertical). Powers the
   * "Servicios" + booking sections of the brochure so it always reflects the
   * tenant's current BarberService catalog. Returns [] for verticals without
   * barber services.
   */
  async getPublicServicesBySlug(slug: string) {
    const site = await this.prisma.publicSite.findFirst({
      where: { publishedSlug: slug, status: 'published' },
      select: {
        tenantId: true,
        branchId: true,
        tenant: {
          select: {
            deletedAt: true,
            vertical: { select: { code: true, isActive: true } },
          },
        },
      },
    });
    if (
      !site ||
      site.tenant.deletedAt ||
      !this.strategies.supports(site.tenant.vertical?.code) ||
      !site.tenant.vertical?.isActive
    ) {
      throw new NotFoundException(`Site ${slug} not found`);
    }

    const services = await this.prisma.barberService.findMany({
      where: { branchId: site.branchId, isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        description: true,
        durationMin: true,
        priceCOP: true,
        color: true,
        imageUrls: true,
        category: true,
        resultDuration: true,
        retouchPriceCOP: true,
        retouchNote: true,
        primaryImageUrl: true,
        assets: {
          where: { showInPublicGallery: true },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
          select: { url: true, alt: true, kind: true },
        },
      },
    });

    return {
      tenantId: site.tenantId,
      branchId: site.branchId,
      services: services.map((service) => {
        const galleryUrls = service.assets.map((asset) => asset.url);
        const primaryFromAssets =
          service.assets.find((asset) => asset.kind === 'primary')?.url ?? null;
        const primaryImageUrl =
          service.primaryImageUrl ??
          primaryFromAssets ??
          service.imageUrls[0] ??
          null;

        const mergedImageUrls = Array.from(
          new Set([
            ...(primaryImageUrl ? [primaryImageUrl] : []),
            ...galleryUrls,
            ...service.imageUrls,
          ]),
        );

        return {
          id: service.id,
          name: service.name,
          description: service.description ?? '',
          category: service.category ?? null,
          durationMin: service.durationMin,
          priceCOP: service.priceCOP,
          color: service.color,
          resultDuration: service.resultDuration ?? null,
          retouchPriceCOP: service.retouchPriceCOP ?? null,
          retouchNote: service.retouchNote ?? null,
          primaryImageUrl,
          imageUrls: mergedImageUrls,
        };
      }),
    };
  }

  async ensureSite(ctx: TenantContext): Promise<SiteWithRelations> {
    const strategy = await this.strategies.resolveForTenant(ctx.tenantId);

    const existing = await this.prisma.publicSite.findUnique({
      where: { branchId: ctx.branchId },
      include: this.includeRelations(),
    });
    if (existing) return existing;

    const [tenant, branch] = await Promise.all([
      this.prisma.tenant.findUniqueOrThrow({
        where: { id: ctx.tenantId },
        select: { id: true, name: true },
      }),
      this.prisma.branch.findUniqueOrThrow({
        where: { id: ctx.branchId },
        select: { id: true, name: true, address: true },
      }),
    ]);

    const seed = await strategy.buildSiteSeed(ctx, { tenant, branch });
    const slug = await this.nextAvailableSlug(seed.slug, strategy);

    const created = await this.prisma.publicSite.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        vertical: strategy.verticalCode,
        slug,
        status: seed.status,
        seoTitle: seed.seoTitle,
        seoDescription: seed.seoDescription,
        ogImageUrl: seed.ogImageUrl,
        themePrimary: seed.themePrimary,
        themeAccent: seed.themeAccent,
        themeInk: seed.themeInk,
        shortName: seed.shortName,
        neighborhood: seed.neighborhood,
        city: seed.city,
        phone: seed.phone,
        whatsapp: seed.whatsapp,
        sections: { create: seed.sections },
      },
      include: this.includeRelations(),
    });
    await this.persistDraftPayloadFromSite(created);
    return created;
  }

  private async ensureSiteForMutation(
    ctx: TenantContext,
  ): Promise<SiteMutationTarget> {
    const existing = await this.prisma.publicSite.findUnique({
      where: { branchId: ctx.branchId },
      select: { id: true, slug: true, status: true },
    });
    if (existing) return existing;

    const created = await this.ensureSite(ctx);
    return { id: created.id, slug: created.slug, status: created.status };
  }

  private includeRelations() {
    return publicSiteInclude;
  }

  private toAdminResponse(site: SiteWithRelations) {
    const draft = this.toDraftProfile(site);
    const published = this.coerceProfile(site.publishedPayload);
    return {
      siteId: site.id,
      slug: site.slug,
      status: site.status,
      draft,
      published,
      publishedAt: site.publishedAt?.toISOString() ?? null,
      updatedAt: site.updatedAt.toISOString(),
      hasUnpublishedChanges:
        !published || !this.samePublishedContent(draft, published),
    };
  }

  private toDraftProfile(site: SiteWithRelations) {
    return this.toSiteDto(site, true, 'draft');
  }

  private toSiteDto(
    site: SiteWithRelations,
    includeDraftFields: boolean,
    version: 'draft' | 'published',
  ) {
    const instagramProfile =
      site.socialLinks.find((social) => social.provider === 'instagram')?.url ??
      '';

    return {
      tenantId: site.tenantId,
      branchId: site.branchId,
      siteId: site.id,
      slug: site.slug,
      status: site.status,
      version,
      publishedAt: site.publishedAt?.toISOString() ?? null,
      updatedAt: site.updatedAt.toISOString(),
      business: {
        name: site.tenant.name,
        shortName: site.shortName ?? undefined,
        address: site.branch.address ?? '',
        neighborhood: site.neighborhood ?? undefined,
        city: site.city ?? undefined,
        phone: site.phone ?? '',
        whatsapp: site.whatsapp ?? undefined,
      },
      seo: {
        title: site.seoTitle ?? site.tenant.name,
        description: site.seoDescription ?? '',
        ogImageUrl: site.ogImageUrl ?? undefined,
      },
      theme: {
        primary: site.themePrimary,
        secondary: site.themeSecondary ?? undefined,
        accent: site.themeAccent,
        ink: site.themeInk,
        background: site.themeBackground,
        surface: site.themeSurface,
        mode: site.themeMode ?? undefined,
        backgroundType: site.themeBackgroundType ?? undefined,
        fontStyle: site.themeFontStyle ?? undefined,
        logoUrl: site.themeLogoUrl ?? undefined,
        faviconUrl: site.themeFaviconUrl ?? undefined,
        whatsapp: site.themeWhatsapp ?? undefined,
        radius: site.themeRadius,
      },
      assets: site.assets
        .filter((asset) => includeDraftFields || asset.isVisible)
        .map((asset) => this.toAssetDto(asset)),
      sections: site.sections
        .filter((section) => includeDraftFields || section.isVisible)
        .map((section) => ({
          id: section.id,
          type: section.type,
          isVisible: section.isVisible,
          sortOrder: section.sortOrder,
          width: section.width,
          density: section.density,
          title: section.title ?? undefined,
          eyebrow: section.eyebrow ?? undefined,
          subtitle: section.subtitle ?? undefined,
          body: section.body ?? undefined,
          ctaLabel: section.ctaLabel ?? undefined,
          ctaAction: section.ctaAction ?? undefined,
          ctaHref: section.ctaHref ?? undefined,
          assetIds: section.assetIds,
          settings: section.settings,
        })),
      stats: site.stats
        .filter((stat) => includeDraftFields || stat.isVisible)
        .map((stat) => ({
          id: stat.id,
          label: stat.label,
          value: stat.value,
          isVisible: stat.isVisible,
          sortOrder: stat.sortOrder,
        })),
      highlights: site.highlights
        .filter((highlight) => includeDraftFields || highlight.isVisible)
        .map((highlight) => ({
          id: highlight.id,
          label: highlight.label,
          isVisible: highlight.isVisible,
          sortOrder: highlight.sortOrder,
        })),
      socials: site.socialLinks
        .filter((social) => includeDraftFields || social.isVisible)
        .map((social) => ({
          id: social.id,
          provider: social.provider,
          label: social.label,
          url: social.url,
          isVisible: social.isVisible,
          sortOrder: social.sortOrder,
        })),
      instagram: {
        profileUrl: instagramProfile,
        posts: site.instagramPosts
          .filter((post) => includeDraftFields || post.isVisible)
          .map((post) => ({
            id: post.id,
            url: post.url,
            kind: post.kind,
            isVisible: post.isVisible,
            sortOrder: post.sortOrder,
          })),
      },
    };
  }

  private toAssetDto(asset: {
    id: string;
    kind: string;
    url: string;
    alt: string;
    width: number | null;
    height: number | null;
    fit: string;
    focalPoint: string;
    isVisible?: boolean;
    sortOrder?: number;
    path?: string | null;
    bucket?: string | null;
  }) {
    return {
      id: asset.id,
      kind: asset.kind,
      url: asset.url,
      alt: asset.alt,
      width: asset.width ?? undefined,
      height: asset.height ?? undefined,
      fit: asset.fit,
      focalPoint: asset.focalPoint,
    };
  }

  private coerceProfile(raw: Prisma.JsonValue) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    return raw as Record<string, unknown>;
  }

  private samePublishedContent(
    draft: Record<string, unknown>,
    published: Record<string, unknown>,
  ) {
    return (
      this.stableStringify(this.stripSnapshotMetadata(draft)) ===
      this.stableStringify(this.stripSnapshotMetadata(published))
    );
  }

  private stripSnapshotMetadata(profile: Record<string, unknown>) {
    const clone = { ...profile };
    delete clone.status;
    delete clone.version;
    delete clone.publishedAt;
    delete clone.updatedAt;
    return clone;
  }

  private stableStringify(value: unknown): string {
    if (Array.isArray(value)) {
      return `[${value.map((entry) => this.stableStringify(entry)).join(',')}]`;
    }
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record)
        .sort()
        .map(
          (key) =>
            `${JSON.stringify(key)}:${this.stableStringify(record[key])}`,
        )
        .join(',')}}`;
    }
    return JSON.stringify(value);
  }

  private async persistDraftPayload(siteId: string) {
    const site = await this.prisma.publicSite.findUniqueOrThrow({
      where: { id: siteId },
      include: this.includeRelations(),
    });
    return this.persistDraftPayloadFromSite(site);
  }

  private async persistDraftPayloadFromSite(site: SiteWithRelations) {
    const draft = this.toDraftProfile(site);
    await this.prisma.publicSite.update({
      where: { id: site.id },
      data: { draftPayload: draft as Prisma.InputJsonValue },
    });
    return site;
  }

  /**
   * Sube un archivo a Supabase Storage delegando validación + conversión
   * WebP al {@link ImageUploadService} compartido. Devuelve metadata uniforme
   * para persistir el `PublicSiteAsset`.
   */
  private async uploadFile(
    ctx: TenantContext,
    siteId: string,
    kind: string,
    file?: UploadedFile,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Image file is required');
    }
    return this.imageUpload.uploadImage({
      file,
      kind: this.mapKindToImageKind(kind),
      pathPrefix: `tenants/${ctx.tenantId}/barber/public-site/${siteId}/${kind}`,
    });
  }

  private mapKindToImageKind(kind: string): ImageKind {
    switch (kind) {
      case 'logo':
      case 'hero':
      case 'gallery':
      case 'background':
      case 'thumbnail':
        return kind;
      default:
        return 'default';
    }
  }

  private async downloadRemoteImage(url: string): Promise<DownloadedRemoteImage> {
    const parsed = this.parseUrl(url);
    this.assertSafeExternalImageUrl(parsed);

    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      EXTERNAL_IMAGE_DOWNLOAD_TIMEOUT_MS,
    );
    let response: Response;
    try {
      response = await fetch(url, {
        redirect: 'follow',
        signal: controller.signal,
      });
    } catch {
      throw new BadRequestException('Could not download external image');
    } finally {
      clearTimeout(timeout);
    }

    this.assertSafeExternalImageUrl(new URL(response.url));
    if (!response.ok) {
      throw new BadRequestException('Could not download external image');
    }

    const contentType = response.headers.get('content-type')?.split(';')[0];
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('Image file must be 5 MB or smaller');
    }

    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('Image file must be 5 MB or smaller');
    }
    return { buffer, contentType, sizeBytes: buffer.length };
  }

  private assertSafeExternalImageUrl(url: URL) {
    if (url.protocol !== 'https:') {
      throw new BadRequestException('External image URL must use https');
    }

    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost')) {
      throw new BadRequestException('External image URL host is not allowed');
    }

    if (this.isBlockedIpLiteral(host)) {
      throw new BadRequestException('External image URL host is not allowed');
    }
  }

  private isBlockedIpLiteral(host: string) {
    const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
      const parts = ipv4.slice(1).map(Number);
      if (parts.some((part) => part > 255)) return true;
      const [a, b] = parts;
      return (
        a === 10 ||
        a === 127 ||
        a === 0 ||
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168)
      );
    }

    const normalized = host.replace(/^\[|\]$/g, '');
    return (
      normalized === '::1' ||
      normalized === '::' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe80:')
    );
  }

  private async assertSlugAvailable(
    slug: string,
    strategy: VerticalSiteStrategy,
    currentSiteId?: string,
    ownerBranchId?: string,
  ) {
    if (strategy.reservedSlugs().has(slug)) {
      throw new BadRequestException({
        code: 'PUBLIC_SITE_SLUG_RESERVED',
        message: `Public site slug is reserved: ${slug}`,
      });
    }

    const [site, publishedSite] = await Promise.all([
      this.prisma.publicSite.findUnique({
        where: { slug },
        select: { id: true },
      }),
      this.prisma.publicSite.findFirst({
        where: { publishedSlug: slug },
        select: { id: true },
      }),
    ]);
    if (
      (site && site.id !== currentSiteId) ||
      (publishedSite && publishedSite.id !== currentSiteId)
    ) {
      throw new ConflictException({
        code: 'PUBLIC_SITE_SLUG_TAKEN',
        message: `Public site slug is already taken: ${slug}`,
      });
    }
    if (await strategy.extraSlugConflict(slug, ownerBranchId)) {
      throw new ConflictException({
        code: 'PUBLIC_SITE_SLUG_TAKEN',
        message: `Public site slug is already taken: ${slug}`,
      });
    }
  }

  private async nextAvailableSlug(
    baseSlug: string,
    strategy: VerticalSiteStrategy,
  ) {
    const candidate = slugify(baseSlug) || strategy.verticalCode;
    for (let index = 0; index < 100; index += 1) {
      const slug = index === 0 ? candidate : `${candidate}-${index + 1}`;
      try {
        await this.assertSlugAvailable(slug, strategy);
        return slug;
      } catch (error) {
        if (!(error instanceof ConflictException)) throw error;
      }
    }
    throw new ConflictException(
      'Could not generate available public site slug',
    );
  }

  private assertSectionRules(sections: PublicSiteSectionDto[]) {
    const visibleHeroes = sections.filter(
      (section) => section.type === 'hero' && section.isVisible,
    );
    if (visibleHeroes.length > 1) {
      throw new BadRequestException('Only one visible hero section is allowed');
    }
  }

  private async assertSectionAssetIds(
    siteId: string,
    sections: PublicSiteSectionDto[],
  ) {
    const assetIds = [...new Set(sections.flatMap((s) => s.assetIds ?? []))];
    if (assetIds.length === 0) return;

    const count = await this.prisma.publicSiteAsset.count({
      where: { siteId, id: { in: assetIds } },
    });
    if (count !== assetIds.length) {
      throw new BadRequestException('One or more section assets are invalid');
    }
  }

  private async assertPublishable(
    site: SiteWithRelations,
    strategy: VerticalSiteStrategy,
  ) {
    const missing = await strategy.collectMissing({
      id: site.id,
      branchId: site.branchId,
      slug: site.slug,
      phone: site.phone,
      whatsapp: site.whatsapp,
      ogImageUrl: site.ogImageUrl,
      tenant: { name: site.tenant.name },
      sections: site.sections.map((section) => ({
        type: section.type,
        isVisible: section.isVisible,
        title: section.title,
        subtitle: section.subtitle,
      })),
      assets: site.assets.map((asset) => ({
        kind: asset.kind,
        isVisible: asset.isVisible,
      })),
    });

    if (missing.length > 0) {
      throw new BadRequestException({
        code: 'PUBLIC_SITE_NOT_PUBLISHABLE',
        message: `Missing content: ${missing.join(', ')}`,
        missing,
      });
    }
  }

  private assertUnique(values: string[], label: string) {
    if (new Set(values).size !== values.length) {
      throw new BadRequestException(
        `Duplicate ${label} values are not allowed`,
      );
    }
  }

  private assertSocialUrl(provider: string, rawUrl: string) {
    const url = this.parseUrl(rawUrl);
    const host = url.hostname.replace(/^www\./, '');
    const allowed: Record<string, string[]> = {
      instagram: ['instagram.com'],
      facebook: ['facebook.com', 'fb.com'],
      tiktok: ['tiktok.com'],
      whatsapp: ['wa.me', 'api.whatsapp.com'],
      website: [],
      google_maps: ['maps.google.com', 'google.com', 'goo.gl'],
    };
    const domains = allowed[provider] ?? [];
    if (
      domains.length > 0 &&
      !domains.some((domain) => host.endsWith(domain))
    ) {
      throw new BadRequestException(`Invalid ${provider} URL`);
    }
  }

  private assertInstagramUrl(post: PublicSiteInstagramPostDto) {
    const url = this.parseUrl(post.url);
    const host = url.hostname.replace(/^www\./, '');
    if (!host.endsWith('instagram.com')) {
      throw new BadRequestException('Instagram posts must use instagram.com');
    }
    const expected = post.kind === 'reel' ? '/reel/' : '/p/';
    if (!url.pathname.includes(expected)) {
      throw new BadRequestException(`Instagram ${post.kind} URL is invalid`);
    }
  }

  private parseUrl(rawUrl: string) {
    try {
      return new URL(rawUrl);
    } catch {
      throw new BadRequestException('Invalid URL');
    }
  }

  private toStatCreate(siteId: string, stat: PublicSiteStatDto) {
    return {
      siteId,
      label: stat.label,
      value: stat.value,
      isVisible: stat.isVisible,
      sortOrder: stat.sortOrder,
    };
  }

  private toHighlightCreate(siteId: string, highlight: PublicSiteHighlightDto) {
    return {
      siteId,
      label: highlight.label,
      isVisible: highlight.isVisible,
      sortOrder: highlight.sortOrder,
    };
  }

  assertTenantOwnsAssetPath(ctx: TenantContext, path: string) {
    const tenantPrefix = `tenants/${ctx.tenantId}/`;
    if (!path.startsWith(tenantPrefix)) {
      throw new ForbiddenException('Asset path does not belong to this tenant');
    }
  }
}
