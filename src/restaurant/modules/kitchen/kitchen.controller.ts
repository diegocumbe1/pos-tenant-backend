import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { KitchenService } from './kitchen.service';
import {
  KITCHEN_TICKET_STATUSES,
  UpdateTicketStatusDto,
} from './dto/update-ticket-status.dto';

@ApiTags('Kitchen')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/kitchen/tickets')
export class KitchenController {
  constructor(private readonly kitchenService: KitchenService) {}

  @Get()
  @ApiQuery({
    name: 'status',
    required: false,
    enum: KITCHEN_TICKET_STATUSES as unknown as string[],
  })
  findAll(
    @CurrentTenant() ctx: TenantContext,
    @Query('status') status?: string,
  ) {
    return this.kitchenService.findTickets(ctx, status);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateTicketStatusDto,
  ) {
    return this.kitchenService.updateStatus(ctx, id, dto.status);
  }
}
