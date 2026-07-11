import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import {
  ImageKind,
  ImageUploadService,
  UploadedImageFile,
} from './image-upload.service';
import {
  DeleteAssetDto,
  UploadAssetDto,
  UploadCatalogImagesDto,
} from './dto/upload-asset.dto';

type UploadedFile = UploadedImageFile;

// Ancho máximo de salida por tipo de asset. Todas las imágenes se reescalan y
// se convierten a WebP en `ImageUploadService`, así el navegador nunca descarga
// la foto original de varios MB. Las tarjetas de menú/POS se ven a ~240px, por
// eso 640px (thumbnail) cubre pantallas retina con archivos de decenas de KB.
const PRODUCT_IMAGE_KIND: ImageKind = 'thumbnail';
const BARBER_SERVICE_IMAGE_KIND: ImageKind = 'service';

@Injectable()
export class AssetsService {
  constructor(
    private readonly supabase: SupabaseService,
    private readonly prisma: PrismaService,
    private readonly imageUpload: ImageUploadService,
  ) {}

  async upload(ctx: TenantContext, dto: UploadAssetDto, file?: UploadedFile) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('Image file is required');
    }

    this.validateScope(dto);

    // Optimiza (auto-rota EXIF + reescala + WebP q80) antes de subir. Los MIME/
    // tamaño/dimensiones los valida `ImageUploadService`.
    const uploaded = await this.imageUpload.uploadImage({
      file,
      pathPrefix: this.buildPathPrefix(ctx.tenantId, dto),
      // El QR debe quedar nítido para escanear → 'section' (1600px). Menú por kind, producto thumbnail.
      kind:
        dto.scope === 'payment'
          ? 'section'
          : dto.scope === 'menu'
            ? this.menuKind(dto.kind)
            : PRODUCT_IMAGE_KIND,
    });

    return {
      ok: true,
      bucket: uploaded.bucket,
      path: uploaded.path,
      publicUrl: uploaded.publicUrl,
      contentType: uploaded.contentType,
      sizeBytes: uploaded.sizeBytes,
      width: uploaded.width,
      height: uploaded.height,
    };
  }

  /** El banner de la carta es una portada ancha; el logo va pequeño. */
  private menuKind(kind: string): ImageKind {
    return kind === 'banner' ? 'section' : 'logo';
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

    const kind =
      normalizedType === 'product'
        ? PRODUCT_IMAGE_KIND
        : BARBER_SERVICE_IMAGE_KIND;

    const uploadedImages = await Promise.all(
      files.map((file) =>
        this.imageUpload.uploadImage({
          file,
          pathPrefix: this.buildCatalogPathPrefix(
            ctx.tenantId,
            normalizedType,
            itemId,
          ),
          kind,
        }),
      ),
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

    if (dto.scope === 'payment' && dto.kind !== 'payment-qr') {
      throw new BadRequestException('Payment assets must use payment-qr');
    }

    if (dto.kind === 'product-image' && !dto.entityId) {
      throw new BadRequestException('entityId is required for product images');
    }
  }

  // Carpeta destino (sin filename): `ImageUploadService` appendea `<ts>-<uuid>.webp`.
  private buildPathPrefix(tenantId: string, dto: UploadAssetDto) {
    if (dto.scope === 'menu') {
      return `tenants/${tenantId}/menu/${dto.kind}`;
    }

    if (dto.scope === 'payment') {
      return `tenants/${tenantId}/payment/qr`;
    }

    const entityId = this.cleanPathSegment(dto.entityId!);
    return `tenants/${tenantId}/products/${entityId}`;
  }

  private buildCatalogPathPrefix(
    tenantId: string,
    itemType: CatalogItemType,
    itemId: string,
  ) {
    const cleanItemId = this.cleanPathSegment(itemId);
    return `tenants/${tenantId}/catalog/${itemType}/${cleanItemId}`;
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
