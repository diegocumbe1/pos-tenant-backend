import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  PublishMenuPublicConfigDto,
  UpdateMenuPublicConfigDto,
} from './dto/menu-public-config.dto';
import { MenuPublicService } from './menu-public.service';

@ApiTags('PublicMenu')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/menu-public')
export class MenuPublicController {
  constructor(private readonly menuPublicService: MenuPublicService) {}

  @Get('config')
  getConfig(@CurrentTenant() ctx: TenantContext) {
    return this.menuPublicService.getConfig(ctx);
  }

  @Patch('config')
  updateConfig(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdateMenuPublicConfigDto,
  ) {
    return this.menuPublicService.updateConfig(ctx, dto);
  }

  @Post('publish')
  publish(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: PublishMenuPublicConfigDto,
  ) {
    return this.menuPublicService.publish(ctx, dto);
  }
}

@ApiTags('PublicMenu')
@Controller('public/menu')
export class PublicMenuController {
  constructor(private readonly menuPublicService: MenuPublicService) {}

  @Get(':slug')
  @Header('Cache-Control', 'public, max-age=60')
  getPublicMenu(@Param('slug') slug: string) {
    return this.menuPublicService.publicMenu(slug);
  }
}
