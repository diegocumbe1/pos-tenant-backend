import {
  Body,
  Controller,
  Delete,
  Param,
  Query,
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
  ApiOperation,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { MAX_VIDEO_MB } from './image-upload.service';
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
        file: {
          type: 'string',
          format: 'binary',
          description:
            'Images for menu/product/payment QR/shipment support, or ' +
            'application/pdf for payment-qr (Nu/Bre-B) and shipment-support ' +
            '(guía de la transportadora).',
        },
        scope: {
          type: 'string',
          enum: ['menu', 'product', 'payment', 'shipment'],
        },
        kind: {
          type: 'string',
          enum: [
            'logo',
            'banner',
            'product-image',
            'payment-qr',
            'shipment-support',
          ],
        },
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

  @Post('catalog/retail-product/:itemId/video')
  @ApiOperation({
    summary: `Video de producto de tienda (MP4/WebM/MOV, máx. ${MAX_VIDEO_MB} MB)`,
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  // Un mega por encima del límite real para que un archivo apenas pasado llegue
  // entero y el servicio responda "pesa más de 20 MB" en vez del error genérico
  // de archivo truncado.
  @UseInterceptors(
    FileInterceptor('file', {
      limits: { fileSize: (MAX_VIDEO_MB + 1) * 1024 * 1024 },
    }),
  )
  uploadRetailVideo(
    @CurrentTenant() ctx: TenantContext,
    @Param('itemId') itemId: string,
    @UploadedFile() file: unknown,
  ) {
    return this.assetsService.uploadRetailProductVideo(
      ctx,
      itemId,
      file as UploadedAssetFile,
    );
  }

  // La URL va por query y no en el cuerpo: un DELETE con body no lo soportan
  // todos los clientes ni proxies, y el `ApiClient` del frontend no lo manda.
  @Delete('catalog/retail-product/:itemId/video')
  @ApiOperation({ summary: 'Quitar el video del producto' })
  removeRetailVideo(
    @CurrentTenant() ctx: TenantContext,
    @Param('itemId') itemId: string,
    @Query('url') url: string,
  ) {
    return this.assetsService.removeRetailProductVideo(ctx, itemId, url);
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
