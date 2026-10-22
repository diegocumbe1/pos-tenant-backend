import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import {
  CreatePaymentCommitmentDto,
  UpdatePaymentCommitmentDto,
} from './dto/retail-payment-commitment.dto';
import { RetailPaymentCommitmentsService } from './retail-payment-commitments.service';

/** Compromisos de pago: con los permisos de ventas, igual que los abonos. */
@ApiTags('Retail')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('retail/payment-commitments')
export class RetailPaymentCommitmentsController {
  constructor(private readonly commitments: RetailPaymentCommitmentsService) {}

  @Get()
  @RequirePermissions('retail:sales:read')
  @ApiQuery({ name: 'open', required: false, type: Boolean })
  @ApiQuery({ name: 'saleId', required: false })
  @ApiQuery({ name: 'customerId', required: false })
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query('open') open?: string,
    @Query('saleId') saleId?: string,
    @Query('customerId') customerId?: string,
  ) {
    return this.commitments.list(ctx, {
      open: open === 'true',
      saleId: saleId || undefined,
      customerId: customerId || undefined,
    });
  }

  @Post()
  @RequirePermissions('retail:sales:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreatePaymentCommitmentDto,
  ) {
    return this.commitments.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('retail:sales:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdatePaymentCommitmentDto,
  ) {
    return this.commitments.update(ctx, id, dto);
  }

  @Post(':id/cancel')
  @RequirePermissions('retail:sales:write')
  cancel(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.commitments.cancel(ctx, id);
  }

  /** Se mandó el recordatorio: queda anotado para no mandarlo dos veces. */
  @Post(':id/reminded')
  @RequirePermissions('retail:sales:write')
  reminded(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.commitments.markReminded(ctx, id);
  }
}
