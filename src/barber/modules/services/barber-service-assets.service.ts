import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ImageUploadService,
  UploadedImageFile,
} from '../../../assets/image-upload.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { SupabaseService } from '../../../supabase/supabase.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberServiceAssetDto,
  UpdateBarberServiceAssetDto,
  UploadBarberServiceAssetDto,
} from './dto/barber-service-asset.dto';

@Injectable()
export class BarberServiceAssetsService {
  private readonly logger = new Logger(BarberServiceAssetsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
    private readonly imageUpload: ImageUploadService,
    private readonly supabase: SupabaseService,
  ) {}

  async uploadAsset(
    ctx: TenantContext,
    serviceId: string,
    dto: UploadBarberServiceAssetDto,
    file?: UploadedImageFile,
  ) {
    await this.assertService(ctx, serviceId);

    if (!file) {
      throw new BadRequestException('Image file is required');
    }

    const uploaded = await this.imageUpload.uploadImage({
      file,
      kind: 'service',
      pathPrefix: `tenants/${ctx.tenantId}/barber/services/${serviceId}`,
    });

    return this.createAsset(ctx, serviceId, {
      url: uploaded.publicUrl,
      alt: dto.alt,
      kind: dto.kind,
      fit: dto.fit,
      focalPoint: dto.focalPoint,
      showInPublicGallery: dto.showInPublicGallery,
      sortOrder: dto.sortOrder,
    });
  }

  async createAsset(
    ctx: TenantContext,
    serviceId: string,
    dto: CreateBarberServiceAssetDto,
  ) {
    await this.assertService(ctx, serviceId);

    const kind = dto.kind ?? 'gallery';

    return this.prisma.$transaction(async (tx) => {
      const asset = await tx.barberServiceAsset.create({
        data: {
          tenantId: ctx.tenantId,
          serviceId,
          url: dto.url,
          alt: dto.alt,
          kind,
          fit: dto.fit ?? 'cover',
          focalPoint: dto.focalPoint ?? 'center',
          showInPublicGallery: dto.showInPublicGallery ?? true,
          sortOrder: dto.sortOrder ?? 0,
        },
      });

      if (kind === 'primary') {
        await this.applyPrimaryAsset(tx, serviceId, asset.id, asset.url);
      }

      return this.toAssetDto(asset);
    });
  }

  async updateAsset(
    ctx: TenantContext,
    serviceId: string,
    assetId: string,
    dto: UpdateBarberServiceAssetDto,
  ) {
    await this.assertService(ctx, serviceId);
    const existing = await this.prisma.barberServiceAsset.findUnique({
      where: { id: assetId },
      select: { id: true, serviceId: true, tenantId: true, kind: true },
    });
    if (
      !existing ||
      existing.serviceId !== serviceId ||
      existing.tenantId !== ctx.tenantId
    ) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.barberServiceAsset.update({
        where: { id: assetId },
        data: {
          url: dto.url,
          alt: dto.alt,
          kind: dto.kind,
          fit: dto.fit,
          focalPoint: dto.focalPoint,
          showInPublicGallery: dto.showInPublicGallery,
          sortOrder: dto.sortOrder,
        },
      });

      if (dto.kind === 'primary' || (dto.url && existing.kind === 'primary')) {
        await this.applyPrimaryAsset(tx, serviceId, updated.id, updated.url);
      }

      return this.toAssetDto(updated);
    });
  }

  async deleteAsset(ctx: TenantContext, serviceId: string, assetId: string) {
    await this.assertService(ctx, serviceId);
    const existing = await this.prisma.barberServiceAsset.findUnique({
      where: { id: assetId },
      select: {
        id: true,
        serviceId: true,
        tenantId: true,
        kind: true,
        url: true,
      },
    });
    if (
      !existing ||
      existing.serviceId !== serviceId ||
      existing.tenantId !== ctx.tenantId
    ) {
      throw new NotFoundException(`Asset ${assetId} not found`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.barberServiceAsset.delete({ where: { id: assetId } });
      if (existing.kind === 'primary') {
        await tx.barberService.update({
          where: { id: serviceId },
          data: { primaryImageUrl: null },
        });
      }
    });
    await this.releaseFile(ctx.tenantId, existing.url);

    return { ok: true };
  }

  /**
   * Quita una foto del servicio por URL, venga de donde venga: assets, la
   * columna vieja `imageUrls` o `primaryImageUrl`. El editor solo conoce la URL
   * que ve, y una misma foto puede estar repetida en los tres lados; borrarla
   * de uno solo la dejaba viva en el sitio público.
   */
  async removePhoto(ctx: TenantContext, serviceId: string, url: string) {
    await this.assertService(ctx, serviceId);
    const target = url?.trim();
    if (!target) throw new BadRequestException('url is required');

    const service = await this.prisma.barberService.findUnique({
      where: { id: serviceId },
      select: { imageUrls: true, primaryImageUrl: true },
    });
    if (!service) throw new NotFoundException(`Service ${serviceId} not found`);

    const removed = await this.prisma.$transaction(async (tx) => {
      const assets = await tx.barberServiceAsset.deleteMany({
        where: { serviceId, tenantId: ctx.tenantId, url: target },
      });
      const inColumn = service.imageUrls.includes(target);
      const isPrimary = service.primaryImageUrl === target;
      if (inColumn || isPrimary) {
        await tx.barberService.update({
          where: { id: serviceId },
          data: {
            imageUrls: inColumn
              ? service.imageUrls.filter((u) => u !== target)
              : undefined,
            primaryImageUrl: isPrimary ? null : undefined,
          },
        });
      }
      return assets.count > 0 || inColumn || isPrimary;
    });
    if (!removed) {
      throw new NotFoundException('La foto no pertenece a este servicio');
    }

    await this.releaseFile(ctx.tenantId, target);
    return { ok: true };
  }

  /**
   * Borra el archivo del bucket cuando ya nadie lo usa. Duplicar un servicio
   * copia las URLs tal cual (no el archivo), así que borrar a ciegas dejaría
   * rota la foto del servicio hermano. Solo toca archivos de este tenant bajo
   * la carpeta de servicios, y un fallo del bucket no tumba el borrado: la
   * fila ya se fue y el archivo huérfano queda en el log para barrerlo.
   */
  private async releaseFile(tenantId: string, url: string) {
    const marker = `/storage/v1/object/public/${this.supabase.assetsBucket}/`;
    const at = url.indexOf(marker);
    if (at < 0) return;
    const path = decodeURIComponent(
      url.slice(at + marker.length).split('?')[0],
    );
    if (!path.startsWith(`tenants/${tenantId}/barber/services/`)) return;

    const [assets, services, siteAssets] = await Promise.all([
      this.prisma.barberServiceAsset.count({ where: { url } }),
      this.prisma.barberService.count({
        where: { OR: [{ primaryImageUrl: url }, { imageUrls: { has: url } }] },
      }),
      this.prisma.publicSiteAsset.count({ where: { url } }),
    ]);
    if (assets + services + siteAssets > 0) return;

    try {
      await this.supabase.deletePublicAsset(path);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`No se pudo borrar del bucket ${path}: ${msg}`);
    }
  }

  private async assertService(ctx: TenantContext, serviceId: string) {
    await this.tenantHelper.assertScopedRecord(
      'barberService',
      ctx,
      serviceId,
      'Service',
    );
  }

  /**
   * Asegura un único asset con kind="primary" por servicio y sincroniza
   * `BarberService.primaryImageUrl` con su URL — el frontend público lo
   * lee directo del servicio sin tener que cargar todos los assets.
   *
   * La portada anterior queda como histórico pero FUERA de la galería pública:
   * la pantalla de Servicios solo maneja una portada, así que "cambiar la foto"
   * es reemplazarla. Antes quedaba con showInPublicGallery=true y cada cambio
   * sumaba una foto vieja al sitio publicado que el dueño no veía en el editor.
   */
  private async applyPrimaryAsset(
    tx: Prisma.TransactionClient,
    serviceId: string,
    assetId: string,
    url: string,
  ) {
    if (!url) {
      throw new BadRequestException('Primary asset requires a url');
    }
    await tx.barberServiceAsset.updateMany({
      where: { serviceId, kind: 'primary', NOT: { id: assetId } },
      data: { kind: 'gallery', showInPublicGallery: false },
    });
    await tx.barberService.update({
      where: { id: serviceId },
      data: { primaryImageUrl: url },
    });
  }

  private toAssetDto(asset: {
    id: string;
    url: string;
    alt: string | null;
    kind: string;
    fit: string;
    focalPoint: string;
    showInPublicGallery: boolean;
    sortOrder: number;
    createdAt: Date;
  }) {
    return {
      id: asset.id,
      url: asset.url,
      alt: asset.alt,
      kind: asset.kind,
      fit: asset.fit,
      focalPoint: asset.focalPoint,
      showInPublicGallery: asset.showInPublicGallery,
      sortOrder: asset.sortOrder,
      createdAt: asset.createdAt,
    };
  }
}
