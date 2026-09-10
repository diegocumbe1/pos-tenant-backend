import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
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
import { CurrentTenant } from '../../auth/decorators/current-tenant.decorator';
import { RequireAnyPermission } from '../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../auth/guards/permissions.guard';
import { TenantGuard } from '../../auth/guards/tenant.guard';
import { TenantContext } from '../../auth/types/tenant-context.interface';
import { PublicSiteService } from './public-site.service';
import {
  CreatePublicSiteAssetFromUrlDto,
  ReplacePublicSiteHighlightsDto,
  ReplacePublicSiteInstagramDto,
  ReplacePublicSiteSectionsDto,
  ReplacePublicSiteSocialsDto,
  ReplacePublicSiteStatsDto,
  UpdatePublicSiteAssetDto,
  UpdatePublicSiteDto,
  UploadPublicSiteAssetDto,
} from './dto/public-site.dto';

type UploadedAssetFile = {
  buffer?: Buffer;
  mimetype?: string;
  size?: number;
  originalname?: string;
};

@ApiTags('PublicSiteAdmin')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('admin/public-site')
export class PublicSiteController {
  constructor(private readonly publicSiteService: PublicSiteService) {}

  @Get()
  @RequireAnyPermission('barber:settings:read', 'retail:settings:read')
  getSite(@CurrentTenant() ctx: TenantContext) {
    return this.publicSiteService.getAdminSite(ctx);
  }

  @Get('preview')
  @RequireAnyPermission('barber:settings:read', 'retail:settings:read')
  preview(@CurrentTenant() ctx: TenantContext) {
    return this.publicSiteService.getPreview(ctx);
  }

  /**
   * Slug y estado del sitio, sin crearlo y sin permiso de Ajustes.
   *
   * Lo usa el front para invalidar el HTML cacheado del sitio público cuando se
   * edita el catálogo. Es información del propio tenant y no expone nada que su
   * gente no vea en la barra de direcciones, así que basta con estar dentro:
   * exigir `settings:read` dejaría al encargado corrigiendo un precio sin poder
   * refrescar el sitio, y `GET /admin/public-site` además crearía el borrador.
   */
  @Get('status')
  status(@CurrentTenant() ctx: TenantContext) {
    return this.publicSiteService.getSiteStatus(ctx);
  }

  @Patch()
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  updateSite(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdatePublicSiteDto,
  ) {
    return this.publicSiteService.updateSite(ctx, dto);
  }

  @Put('sections')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  replaceSections(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: ReplacePublicSiteSectionsDto,
  ) {
    return this.publicSiteService.replaceSections(ctx, dto);
  }

  @Post('assets')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_242_880 } }))
  uploadAsset(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UploadPublicSiteAssetDto,
    @UploadedFile() file: UploadedAssetFile,
  ) {
    return this.publicSiteService.uploadAsset(ctx, dto, file);
  }

  @Post('assets/from-url')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  createAssetFromUrl(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreatePublicSiteAssetFromUrlDto,
  ) {
    return this.publicSiteService.createAssetFromUrl(ctx, dto);
  }

  @Patch('assets/:assetId')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_242_880 } }))
  updateAsset(
    @CurrentTenant() ctx: TenantContext,
    @Param('assetId') assetId: string,
    @Body() dto: UpdatePublicSiteAssetDto,
    @UploadedFile() file?: UploadedAssetFile,
  ) {
    return this.publicSiteService.updateAsset(ctx, assetId, dto, file);
  }

  @Delete('assets/:assetId')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  deleteAsset(
    @CurrentTenant() ctx: TenantContext,
    @Param('assetId') assetId: string,
  ) {
    return this.publicSiteService.deleteAsset(ctx, assetId);
  }

  @Put('socials')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  replaceSocials(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: ReplacePublicSiteSocialsDto,
  ) {
    return this.publicSiteService.replaceSocials(ctx, dto);
  }

  @Put('instagram')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  replaceInstagram(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: ReplacePublicSiteInstagramDto,
  ) {
    return this.publicSiteService.replaceInstagram(ctx, dto);
  }

  @Put('stats')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  replaceStats(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: ReplacePublicSiteStatsDto,
  ) {
    return this.publicSiteService.replaceStats(ctx, dto);
  }

  @Put('highlights')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  replaceHighlights(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: ReplacePublicSiteHighlightsDto,
  ) {
    return this.publicSiteService.replaceHighlights(ctx, dto);
  }

  @Post('publish')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  publish(@CurrentTenant() ctx: TenantContext) {
    return this.publicSiteService.publish(ctx);
  }

  @Post('unpublish')
  @RequireAnyPermission('barber:settings:write', 'retail:settings:write')
  unpublish(@CurrentTenant() ctx: TenantContext) {
    return this.publicSiteService.unpublish(ctx);
  }
}
