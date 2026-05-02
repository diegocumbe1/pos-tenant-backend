import {
  BadRequestException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { SupabaseService } from '../supabase/supabase.service';
import { DeleteAssetDto, UploadAssetDto } from './dto/upload-asset.dto';

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
  constructor(private readonly supabase: SupabaseService) {}

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

  private buildPath(
    tenantId: string,
    dto: UploadAssetDto,
    extension: string,
  ) {
    const assetId = `${Date.now()}-${randomUUID()}.${extension}`;

    if (dto.scope === 'menu') {
      return `tenants/${tenantId}/menu/${dto.kind}/${assetId}`;
    }

    const entityId = this.cleanPathSegment(dto.entityId!);
    return `tenants/${tenantId}/products/${entityId}/${assetId}`;
  }

  private cleanPathSegment(value: string) {
    const clean = value.replace(/[^a-zA-Z0-9_-]/g, '');
    if (!clean) throw new BadRequestException('Invalid entityId');
    return clean;
  }
}
