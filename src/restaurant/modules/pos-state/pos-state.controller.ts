import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PosStateService } from './pos-state.service';

@ApiTags('POS State')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/pos-state')
export class PosStateController {
  constructor(private readonly posStateService: PosStateService) {}

  @Get()
  findCurrent(@CurrentTenant() ctx: TenantContext) {
    return this.posStateService.findCurrent(ctx);
  }
}
