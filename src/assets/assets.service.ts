import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  DeleteAssetDto,
  UploadAssetDto,
  UploadCatalogImagesDto,
} from './dto/upload-asset.dto';

type UploadedFile = {
  buffer?: Buffer;
  mimetype?: string;
  size?: number;
  originalname?: string;
};

const ALLOWED_MIME_TYPES = new Map([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/webp', 'webp'],
]);

const MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;

@Injectable()
export class AssetsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
  ) {}

  async upload(ctx: TenantContext, dto: UploadAssetDto, file?: UploadedFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Image file is required');
    }

    const extension = ALLOWED_MIME_TYPES.get(file.mimetype ?? '');
    if (!extension) {
      throw new BadRequestException(
        'Only image/jpeg, image/png and image/webp files are allowed',
      );
    }

    if ((file.size ?? file.buffer.length) > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('Image file must be 5 MB or smaller');
    }

    this.validateScope(dto);
    const path = this.buildPath(ctx.tenantId, dto, extension);
    const uploaded = await this.supabase.uploadPublicAsset({
      path,
      buffer: file.buffer,
      contentType: file.mimetype!,
    });

    return {
      ok: true,
      ...uploaded,
      contentType: file.mimetype,
      sizeBytes: file.size ?? file.buffer.length,
    };
  }

  async uploadCatalogImages(
    ctx: TenantContext,
    itemType: string,
    itemId: string,
    dto: UploadCatalogImagesDto,
    files?: UploadedFile[],
  ) {
    if (!files?.length) {
      throw new BadRequestException('At least one image file is required');
    }

    const normalizedType = this.normalizeCatalogItemType(itemType);
    await this.assertCatalogItem(ctx, normalizedType, itemId);

    const uploadedImages = await Promise.all(
      files.map(async (file) => {
        const image = this.validateImageFile(file);
        const path = this.buildCatalogPath(
          ctx.tenantId,
          normalizedType,
          itemId,
          image.extension,
        );
        const uploaded = await this.supabase.uploadPublicAsset({
          path,
          buffer: file.buffer!,
          contentType: file.mimetype!,
        });

        return {
          ...uploaded,
          contentType: file.mimetype,
          sizeBytes: file.size ?? file.buffer!.length,
        };
      }),
    );

    const incomingUrls = uploadedImages.map((image) => image.publicUrl);
    const imageUrls = await this.updateCatalogImageUrls(
      normalizedType,
      itemId,
      incomingUrls,
      dto.mode ?? 'append',
    );

    return {
      ok: true,
      itemType: normalizedType,
      itemId,
      mode: dto.mode ?? 'append',
      images: uploadedImages,
      imageUrls,
    };
  }

  async delete(ctx: TenantContext, dto: DeleteAssetDto) {
    const tenantPrefix = `tenants/${ctx.tenantId}/`;
    if (!dto.path.startsWith(tenantPrefix)) {
      throw new ForbiddenException('Asset path does not belong to this tenant');
    }

    await this.supabase.deletePublicAsset(dto.path);
    return { ok: true };
  }

  private validateScope(dto: UploadAssetDto) {
    if (dto.scope === 'menu' && !['logo', 'banner'].includes(dto.kind)) {
      throw new BadRequestException('Menu assets must be logo or banner');
    }

    if (dto.scope === 'product' && dto.kind !== 'product-image') {
      throw new BadRequestException('Product assets must use product-image');
    }

    if (dto.kind === 'product-image' && !dto.entityId) {
      throw new BadRequestException('entityId is required for product images');
    }
  }

  private validateImageFile(file?: UploadedFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Image file is required');
    }

    const extension = ALLOWED_MIME_TYPES.get(file.mimetype ?? '');
    if (!extension) {
      throw new BadRequestException(
        'Only image/jpeg, image/png and image/webp files are allowed',
      );
    }

    if ((file.size ?? file.buffer.length) > MAX_FILE_SIZE_BYTES) {
      throw new BadRequestException('Image file must be 5 MB or smaller');
    }

    return { extension };
  }

  private buildPath(tenantId: string, dto: UploadAssetDto, extension: string) {
    const assetId = `${Date.now()}-${randomUUID()}.${extension}`;

    if (dto.scope === 'menu') {
      return `tenants/${tenantId}/menu/${dto.kind}/${assetId}`;
    }

    const entityId = this.cleanPathSegment(dto.entityId!);
    return `tenants/${tenantId}/products/${entityId}/${assetId}`;
  }

  private buildCatalogPath(
    tenantId: string,
    itemType: CatalogItemType,
    itemId: string,
    extension: string,
  ) {
    const cleanItemId = this.cleanPathSegment(itemId);
    const assetId = `${Date.now()}-${randomUUID()}.${extension}`;
    return `tenants/${tenantId}/catalog/${itemType}/${cleanItemId}/${assetId}`;
  }

  private normalizeCatalogItemType(itemType: string): CatalogItemType {
    if (itemType === 'product' || itemType === 'products') return 'product';
    if (
      itemType === 'service' ||
      itemType === 'services' ||
      itemType === 'barber-service' ||
      itemType === 'barber-services'
    ) {
      return 'barber-service';
    }

    throw new BadRequestException('itemType must be product or barber-service');
  }

  private async assertCatalogItem(
    ctx: TenantContext,
    itemType: CatalogItemType,
    itemId: string,
  ) {
    if (itemType === 'product') {
      const product = await this.prisma.product.findFirst({
        where: { id: itemId, tenantId: ctx.tenantId, deletedAt: null },
        select: { branchId: true },
      });
      if (!product) throw new NotFoundException(`Product ${itemId} not found`);
      if (product.branchId && product.branchId !== ctx.branchId) {
        throw new ForbiddenException('Product does not belong to this branch');
      }
      return;
    }

    const service = await this.prisma.barberService.findFirst({
      where: { id: itemId, tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { id: true },
    });
    if (!service) throw new NotFoundException(`Service ${itemId} not found`);
  }

  private async updateCatalogImageUrls(
    itemType: CatalogItemType,
    itemId: string,
    incomingUrls: string[],
    mode: 'append' | 'replace',
  ) {
    if (itemType === 'product') {
      const product = await this.prisma.product.findUniqueOrThrow({
        where: { id: itemId },
        select: { imageUrls: true },
      });
      const imageUrls =
        mode === 'replace'
          ? incomingUrls
          : [...product.imageUrls, ...incomingUrls];
      const updated = await this.prisma.product.update({
        where: { id: itemId },
        data: { imageUrls },
        select: { imageUrls: true },
      });
      return updated.imageUrls;
    }

    const service = await this.prisma.barberService.findUniqueOrThrow({
      where: { id: itemId },
      select: { imageUrls: true },
    });
    const imageUrls =
      mode === 'replace'
        ? incomingUrls
        : [...service.imageUrls, ...incomingUrls];
    const updated = await this.prisma.barberService.update({
      where: { id: itemId },
      data: { imageUrls },
      select: { imageUrls: true },
    });
    return updated.imageUrls;
  }

  private cleanPathSegment(value: string) {
    const clean = value.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!clean) throw new BadRequestException('Invalid entityId');
    return clean;
  }
}

type CatalogItemType = 'product' | 'barber-service';
