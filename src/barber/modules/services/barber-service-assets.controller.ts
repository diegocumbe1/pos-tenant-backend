import {
  Body,
  Controller,
  Delete,
  Param,
  Patch,
  Post,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiBearerAuth,
  ApiConsumes,
  ApiSecurity,
  ApiTags,
} from '@nestjs/swagger';
import { UploadedImageFile } from '../../../assets/image-upload.service';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberServiceAssetsService } from './barber-service-assets.service';
import {
  CreateBarberServiceAssetDto,
  UpdateBarberServiceAssetDto,
  UploadBarberServiceAssetDto,
} from './dto/barber-service-asset.dto';

@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/services/:serviceId/assets')
export class BarberServiceAssetsController {
  constructor(
    private readonly assetsService: BarberServiceAssetsService,
  ) {}

  @Post()
  @RequirePermissions('barber:services:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceId') serviceId: string,
    @Body() dto: CreateBarberServiceAssetDto,
  ) {
    return this.assetsService.createAsset(ctx, serviceId, dto);
  }

  @Post('upload')
  @RequirePermissions('barber:services:write')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_242_880 } }))
  upload(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceId') serviceId: string,
    @Body() dto: UploadBarberServiceAssetDto,
    @UploadedFile() file?: UploadedImageFile,
  ) {
    return this.assetsService.uploadAsset(ctx, serviceId, dto, file);
  }

  @Patch(':assetId')
  @RequirePermissions('barber:services:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceId') serviceId: string,
    @Param('assetId') assetId: string,
    @Body() dto: UpdateBarberServiceAssetDto,
  ) {
    return this.assetsService.updateAsset(ctx, serviceId, assetId, dto);
  }

  @Delete(':assetId')
  @RequirePermissions('barber:services:write')
  remove(
    @CurrentTenant() ctx: TenantContext,
    @Param('serviceId') serviceId: string,
    @Param('assetId') assetId: string,
  ) {
    return this.assetsService.deleteAsset(ctx, serviceId, assetId);
  }
}
