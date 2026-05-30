import {
  Body,
  Controller,
  Delete,
  Param,
  Post,
  UploadedFile,
  UploadedFiles,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor, FilesInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { AssetsService } from './assets.service';
import {
  DeleteAssetDto,
  UploadAssetDto,
  UploadCatalogImagesDto,
} from './dto/upload-asset.dto';

type UploadedAssetFile = {
  buffer?: Buffer;
  mimetype?: string;
  size?: number;
  originalname?: string;
};

@ApiTags('Assets')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('assets')
export class AssetsController {
  constructor(private readonly assetsService: AssetsService) {}

  @Post('upload')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'scope', 'kind'],
      properties: {
        file: { type: 'string', format: 'binary' },
        scope: { type: 'string', enum: ['menu', 'product'] },
        kind: { type: 'string', enum: ['logo', 'banner', 'product-image'] },
        entityId: { type: 'string' },
      },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_242_880 } }))
  upload(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UploadAssetDto,
    @UploadedFile() file: unknown,
  ) {
    return this.assetsService.upload(ctx, dto, file as UploadedAssetFile);
  }

  @Post('catalog/:itemType/:itemId/images')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['images'],
      properties: {
        images: {
          type: 'array',
          items: { type: 'string', format: 'binary' },
        },
        mode: {
          type: 'string',
          enum: ['append', 'replace'],
          default: 'append',
        },
      },
    },
  })
  @UseInterceptors(
    FilesInterceptor('images', 10, { limits: { fileSize: 5_242_880 } }),
  )
  uploadCatalogImages(
    @CurrentTenant() ctx: TenantContext,
    @Param('itemType') itemType: string,
    @Param('itemId') itemId: string,
    @Body() dto: UploadCatalogImagesDto,
    @UploadedFiles() files: unknown,
  ) {
    return this.assetsService.uploadCatalogImages(
      ctx,
      itemType,
      itemId,
      dto,
      files as UploadedAssetFile[],
    );
  }

  @Delete()
  delete(@CurrentTenant() ctx: TenantContext, @Body() dto: DeleteAssetDto) {
    return this.assetsService.delete(ctx, dto);
  }
}
