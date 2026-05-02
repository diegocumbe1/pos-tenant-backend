import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MenuPublicConfig } from '@prisma/client';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  MenuPublicThemeDto,
  PublishMenuPublicConfigDto,
  UpdateMenuPublicConfigDto,
} from './dto/menu-public-config.dto';

const RESERVED_SLUGS = new Set([
  'api',
  'admin',
  'menu',
  'settings',
  'login',
  'dashboard',
  'app',
]);

@Injectable()
export class MenuPublicService {
  constructor(private readonly prisma: PrismaService) {}

  async getConfig(ctx: TenantContext) {
    const config = await this.ensureConfig(ctx.tenantId, ctx.branchId);
    return this.toConfigDto(config);
  }

  async updateConfig(ctx: TenantContext, dto: UpdateMenuPublicConfigDto) {
    const current = await this.ensureConfig(ctx.tenantId, ctx.branchId);

    if (dto.slug && dto.slug !== current.slug) {
      await this.assertSlugAvailable(dto.slug, ctx.tenantId);
    }

    const updated = await this.prisma.menuPublicConfig.update({
      where: { tenantId: ctx.tenantId },
      data: {
        slug: dto.slug,
        isPublished: dto.isPublished,
        showPrices: dto.showPrices,
        showDescription: dto.showDescription,
        showImages: dto.showImages,
        showUnavailable: dto.showUnavailable,
        showFeaturedBadge: dto.showFeaturedBadge,
        showRatings: dto.showRatings,
        showSavedCount: dto.showSavedCount,
        featuredProductIds: dto.featuredProductIds,
        categoryOrder: dto.categoryOrder,
        branchId: ctx.branchId || current.branchId,
        ...this.toThemeUpdate(dto.theme),
      },
    });

    return this.toConfigDto(updated);
  }

  async publish(ctx: TenantContext, dto: PublishMenuPublicConfigDto) {
    const current = await this.ensureConfig(ctx.tenantId, ctx.branchId);
    const updated = await this.prisma.menuPublicConfig.update({
      where: { tenantId: ctx.tenantId },
      data: {
        isPublished: dto.isPublished,
        branchId: ctx.branchId || current.branchId,
      },
    });

    return this.toConfigDto(updated);
  }

  async publicMenu(slug: string) {
    const config = await this.prisma.menuPublicConfig.findUnique({
      where: { slug },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            vertical: { select: { code: true } },
          },
        },
      },
    });

    if (!config || !config.isPublished) {
      throw new NotFoundException(`Menu ${slug} not found`);
    }

    const branchId =
      config.branchId ??
      (
        await this.prisma.branch.findFirst({
          where: { tenantId: config.tenantId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id;

    const branchFilter = branchId
      ? { OR: [{ branchId: null }, { branchId }] }
      : { branchId: null };

    const [categories, products] = await Promise.all([
      this.prisma.productCategory.findMany({
        where: {
          tenantId: config.tenantId,
          ...branchFilter,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
      this.prisma.product.findMany({
        where: {
          tenantId: config.tenantId,
          deletedAt: null,
          ...(config.showUnavailable ? {} : { isAvailable: true }),
          ...branchFilter,
        },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);

    const categoryRank = new Map(
      config.categoryOrder.map((id, index) => [id, index]),
    );
    const productRank = new Map(
      config.featuredProductIds.map((id, index) => [id, index]),
    );

    return {
      tenant: {
        id: config.tenant.id,
        name: config.tenant.name,
        vertical: config.tenant.vertical?.code ?? null,
      },
      config: this.toConfigDto(config),
      categories: categories
        .sort(
          (a, b) =>
            (categoryRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (categoryRank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
            a.sortOrder - b.sortOrder ||
            a.name.localeCompare(b.name),
        )
        .map((category) => ({
          id: category.id,
          name: category.name,
          emoji: category.emoji,
          sortOrder: category.sortOrder,
        })),
      products: products
        .sort(
          (a, b) =>
            (productRank.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
              (productRank.get(b.id) ?? Number.MAX_SAFE_INTEGER) ||
            a.sortOrder - b.sortOrder ||
            a.name.localeCompare(b.name),
        )
        .map((product) => ({
          id: product.id,
          categoryId: product.categoryId,
          name: product.name,
          description: config.showDescription ? product.description : null,
          priceCOP: product.priceCOP,
          emoji: product.emoji,
          imageUrls: config.showImages ? product.imageUrls : [],
          isAvailable: product.isAvailable,
          sortOrder: product.sortOrder,
        })),
    };
  }

  async ensureConfig(tenantId: string, branchId?: string) {
    const existing = await this.prisma.menuPublicConfig.findUnique({
      where: { tenantId },
    });
    if (existing) return existing;

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);

    const selectedBranchId =
      branchId ||
      (
        await this.prisma.branch.findFirst({
          where: { tenantId },
          orderBy: { createdAt: 'asc' },
          select: { id: true },
        })
      )?.id;

    const slug = await this.nextAvailableSlug(this.slugify(tenant.name));

    return this.prisma.menuPublicConfig.create({
      data: {
        tenantId,
        branchId: selectedBranchId,
        slug,
        isPublished: false,
        showPrices: true,
        showDescription: true,
        showImages: true,
        showUnavailable: false,
        showFeaturedBadge: true,
        showRatings: false,
        showSavedCount: false,
        featuredProductIds: [],
        categoryOrder: [],
        ...this.defaultTheme(tenant.name),
      },
    });
  }

  private async assertSlugAvailable(slug: string, tenantId: string) {
    if (RESERVED_SLUGS.has(slug)) {
      throw new BadRequestException({
        code: 'SLUG_RESERVED',
        message: `Slug is reserved: ${slug}`,
      });
    }

    const existing = await this.prisma.menuPublicConfig.findUnique({
      where: { slug },
      select: { tenantId: true },
    });

    if (existing && existing.tenantId !== tenantId) {
      throw new ConflictException({
        code: 'SLUG_TAKEN',
        message: `Slug is already taken: ${slug}`,
      });
    }
  }

  private async nextAvailableSlug(baseSlug: string) {
    let candidate = baseSlug || 'menu';
    if (RESERVED_SLUGS.has(candidate)) candidate = `${candidate}-1`;

    for (let index = 0; index < 100; index += 1) {
      const slug = index === 0 ? candidate : `${candidate}-${index + 1}`;
      const existing = await this.prisma.menuPublicConfig.findUnique({
        where: { slug },
        select: { id: true },
      });
      if (!existing && !RESERVED_SLUGS.has(slug)) return slug;
    }

    throw new ConflictException({
      code: 'SLUG_TAKEN',
      message: 'Could not generate available slug',
    });
  }

  private toConfigDto(config: MenuPublicConfig) {
    return {
      id: config.id,
      tenantId: config.tenantId,
      branchId: config.branchId,
      slug: config.slug,
      isPublished: config.isPublished,
      showPrices: config.showPrices,
      showDescription: config.showDescription,
      showImages: config.showImages,
      showUnavailable: config.showUnavailable,
      showFeaturedBadge: config.showFeaturedBadge,
      showRatings: config.showRatings,
      showSavedCount: config.showSavedCount,
      featuredProductIds: config.featuredProductIds,
      categoryOrder: config.categoryOrder,
      theme: {
        templateId: config.templateId,
        primaryColor: config.primaryColor,
        accentColor: config.accentColor,
        bannerText: config.bannerText,
        logoMode: config.logoMode,
        logoVariant: config.logoVariant,
        logoFit: config.logoFit,
        logoEmoji: config.logoEmoji,
        logoImageUrl: config.logoImageUrl,
        bannerImageUrl: config.bannerImageUrl,
        heroKicker: config.heroKicker,
        heroTitle: config.heroTitle,
        heroDescription: config.heroDescription,
        featuredTitle: config.featuredTitle,
        featuredDescription: config.featuredDescription,
      },
      createdAt: config.createdAt,
      updatedAt: config.updatedAt,
    };
  }

  private defaultTheme(tenantName: string) {
    return {
      templateId: 'cards',
      primaryColor: '#16a34a',
      accentColor: '#f97316',
      heroTitle: tenantName,
      heroDescription: 'Explora nuestra carta',
      featuredTitle: 'Destacados',
      featuredDescription: 'Los favoritos de la casa',
    };
  }

  private toThemeUpdate(theme?: MenuPublicThemeDto) {
    if (!theme) return {};

    return {
      templateId: this.optionalString(theme.templateId),
      primaryColor: this.optionalString(theme.primaryColor),
      accentColor: this.optionalString(theme.accentColor),
      bannerText: this.optionalNullableString(theme.bannerText),
      logoMode: this.optionalNullableString(theme.logoMode),
      logoVariant: this.optionalNullableString(theme.logoVariant),
      logoFit: this.optionalNullableString(theme.logoFit),
      logoEmoji: this.optionalNullableString(theme.logoEmoji),
      logoImageUrl: this.optionalNullableString(theme.logoImageUrl),
      bannerImageUrl: this.optionalNullableString(theme.bannerImageUrl),
      heroKicker: this.optionalNullableString(theme.heroKicker),
      heroTitle: this.optionalNullableString(theme.heroTitle),
      heroDescription: this.optionalNullableString(theme.heroDescription),
      featuredTitle: this.optionalNullableString(theme.featuredTitle),
      featuredDescription: this.optionalNullableString(theme.featuredDescription),
    };
  }

  private optionalString(value: unknown) {
    return typeof value === 'string' ? value : undefined;
  }

  private optionalNullableString(value: unknown) {
    if (value === null) return null;
    return typeof value === 'string' ? value : undefined;
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
