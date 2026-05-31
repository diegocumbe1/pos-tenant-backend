import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  ImageUploadService,
  UploadedImageFile,
} from '../../../assets/image-upload.service';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberServiceAssetDto,
  UpdateBarberServiceAssetDto,
  UploadBarberServiceAssetDto,
} from './dto/barber-service-asset.dto';

@Injectable()
export class BarberServiceAssetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
    private readonly imageUpload: ImageUploadService,
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
      select: { id: true, serviceId: true, tenantId: true, kind: true },
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

    return { ok: true };
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
      data: { kind: 'gallery' },
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
