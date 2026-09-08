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
type UploadedAssetFile = UploadedImageFile;

// Ancho máximo de salida por tipo de asset. Todas las imágenes se reescalan y
// se convierten a WebP en `ImageUploadService`, así el navegador nunca descarga
// la foto original de varios MB. Las tarjetas de menú/POS se ven a ~240px, por
// eso 640px (thumbnail) cubre pantallas retina con archivos de decenas de KB.
const PRODUCT_IMAGE_KIND: ImageKind = 'thumbnail';
const BARBER_SERVICE_IMAGE_KIND: ImageKind = 'service';

/**
 * Un solo video por producto de tienda.
 *
 * No es técnico: dos videos en la misma ficha es un producto que ya no se
 * explica con un catálogo, y cada uno son hasta 20 MB en un bucket que se paga.
 */
const MAX_VIDEOS_PER_RETAIL_PRODUCT = 1;

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

    // Los dos scopes que aceptan PDF: el QR de pago que dan Nu/Bre-B y los
    // soportes de un envío (la guía suele venir en PDF de la transportadora).
    if (
      (dto.scope === 'payment' || dto.scope === 'shipment') &&
      this.isPdf(file)
    ) {
      const uploaded = await this.imageUpload.uploadPdf({
        file,
        pathPrefix: this.buildPathPrefix(ctx.tenantId, dto),
      });

      return {
        ok: true,
        bucket: uploaded.bucket,
        path: uploaded.path,
        publicUrl: uploaded.publicUrl,
        contentType: uploaded.contentType,
        sizeBytes: uploaded.sizeBytes,
      };
    }

    // Optimiza (auto-rota EXIF + reescala + WebP q80) antes de subir. Los MIME/
    // tamaño/dimensiones los valida `ImageUploadService`.
    const uploaded = await this.imageUpload.uploadImage({
      file,
      pathPrefix: this.buildPathPrefix(ctx.tenantId, dto),
      // El QR debe quedar nítido para escanear → 'section' (1600px, con mínimo).
      //
      // El soporte de un envío va como 'document': mismo tope alto para que se
      // lea el número de la guía, pero SIN mínimo. Un soporte es la foto o el
      // pantallazo que le mandaron, del tamaño que sea; exigirle dimensiones
      // dejaba al dueño sin poder guardar su único respaldo del flete.
      kind:
        dto.scope === 'shipment'
          ? 'document'
          : dto.scope === 'payment'
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

  private isPdf(file: UploadedFile) {
    return file.mimetype?.split(';')[0] === 'application/pdf';
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

    // Retail comparte el tratamiento de imagen de producto (thumbnail), no el
    // de servicio: son fotos de mercancía, no de resultado de un servicio.
    const kind =
      normalizedType === 'barber-service'
        ? BARBER_SERVICE_IMAGE_KIND
        : PRODUCT_IMAGE_KIND;

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

  /**
   * Sube un VIDEO de producto de tienda.
   *
   * Solo retail: es donde el video vende —el clip de 15 segundos mostrando cómo
   * se ve la flor eterna encendida— y donde el dueño hoy lo manda suelto por
   * WhatsApp. Restaurante y barbería no lo han pedido, y cada vertical de más es
   * storage que se paga sin que nadie lo mire.
   *
   * Va a `videoUrls` y NO a `imageUrls`: se pintan distinto (hay que tocarlos
   * para que carguen) y pesan dos órdenes de magnitud más. Mezclarlos obligaría
   * a adivinar por la extensión en cada pantalla.
   */
  async uploadRetailProductVideo(
    ctx: TenantContext,
    itemId: string,
    file: UploadedAssetFile,
  ) {
    await this.assertCatalogItem(ctx, 'retail-product', itemId);

    const product = await this.prisma.retailProduct.findUniqueOrThrow({
      where: { id: itemId },
      select: { videoUrls: true },
    });
    if (product.videoUrls.length >= MAX_VIDEOS_PER_RETAIL_PRODUCT) {
      throw new BadRequestException(
        `Solo se permite ${MAX_VIDEOS_PER_RETAIL_PRODUCT} video por producto. ` +
          `Borra el que hay para subir otro.`,
      );
    }

    const uploaded = await this.imageUpload.uploadVideo({
      file,
      pathPrefix: this.buildCatalogPathPrefix(
        ctx.tenantId,
        'retail-product',
        itemId,
      ),
    });

    const updated = await this.prisma.retailProduct.update({
      where: { id: itemId },
      data: { videoUrls: [...product.videoUrls, uploaded.publicUrl] },
      select: { videoUrls: true },
    });

    return { ok: true, video: uploaded, videoUrls: updated.videoUrls };
  }

  /**
   * Quita un video del producto.
   *
   * El archivo del bucket NO se borra acá: `retail_products.videoUrls` guarda
   * URLs sueltas, sin la ruta interna, así que no hay con qué pedirle a Supabase
   * que lo elimine. Es la misma limitación que ya tienen las fotos de retail —el
   * modelo nació como `String[]`— y arreglarla es migrar retail a una tabla de
   * medios como la de catálogos. Mientras tanto se quita de la vista, que es lo
   * que el dueño espera, y el archivo queda hasta esa migración.
   */
  async removeRetailProductVideo(
    ctx: TenantContext,
    itemId: string,
    url: string,
  ) {
    await this.assertCatalogItem(ctx, 'retail-product', itemId);
    const product = await this.prisma.retailProduct.findUniqueOrThrow({
      where: { id: itemId },
      select: { videoUrls: true },
    });
    const updated = await this.prisma.retailProduct.update({
      where: { id: itemId },
      data: { videoUrls: product.videoUrls.filter((item) => item !== url) },
      select: { videoUrls: true },
    });
    return { ok: true, videoUrls: updated.videoUrls };
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

    if (dto.scope === 'shipment' && dto.kind !== 'shipment-support') {
      throw new BadRequestException(
        'Shipment assets must use shipment-support',
      );
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

    if (dto.scope === 'shipment') {
      // Por envío cuando se sabe cuál: así los soportes de un paquete quedan
      // juntos en el bucket y se pueden barrer de una si se borra el envío.
      const shipmentId = dto.entityId
        ? this.cleanPathSegment(dto.entityId)
        : 'unassigned';
      return `tenants/${tenantId}/shipments/${shipmentId}`;
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
      itemType === 'retail-product' ||
      itemType === 'retail-products' ||
      itemType === 'retail'
    ) {
      return 'retail-product';
    }
    if (
      itemType === 'service' ||
      itemType === 'services' ||
      itemType === 'barber-service' ||
      itemType === 'barber-services'
    ) {
      return 'barber-service';
    }

    throw new BadRequestException(
      'itemType must be product, retail-product or barber-service',
    );
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

    if (itemType === 'retail-product') {
      const product = await this.prisma.retailProduct.findFirst({
        where: {
          id: itemId,
          tenantId: ctx.tenantId,
          branchId: ctx.branchId,
          deletedAt: null,
        },
        select: { id: true },
      });
      if (!product) {
        throw new NotFoundException(`Retail product ${itemId} not found`);
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

    if (itemType === 'retail-product') {
      const product = await this.prisma.retailProduct.findUniqueOrThrow({
        where: { id: itemId },
        select: { imageUrls: true },
      });
      const imageUrls =
        mode === 'replace'
          ? incomingUrls
          : [...product.imageUrls, ...incomingUrls];
      const updated = await this.prisma.retailProduct.update({
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

type CatalogItemType = 'product' | 'barber-service' | 'retail-product';
