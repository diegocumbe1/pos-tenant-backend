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
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { BarberChargesService } from './barber-charges.service';
import {
  BarberPaymentInputDto,
  CoverAppointmentDto,
  CreateBarberChargeDto,
  FreezeBarberChargeDto,
  ListBarberChargesQueryDto,
  ListBarberMembershipsQueryDto,
  RenewBarberChargeDto,
  UpdateBarberChargeDto,
  VoidBarberChargeDto,
} from './dto/barber-charge.dto';

// Cobros y pagos (abonos). Usa los permisos de la agenda: quien atiende la
// recepción es quien cobra, y crear un permiso nuevo obligaría a re-sembrar
// los roles de cada negocio.
@ApiTags('Barber')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('barber/charges')
export class BarberChargesController {
  constructor(private readonly chargesService: BarberChargesService) {}

  @Get()
  @RequirePermissions('barber:appointments:read')
  list(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListBarberChargesQueryDto,
  ) {
    return this.chargesService.list(ctx, query);
  }

  @Get('summary')
  @RequirePermissions('barber:appointments:read')
  summary(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListBarberChargesQueryDto,
  ) {
    return this.chargesService.summary(ctx, query.from, query.to);
  }

  // Cómo va la membresía de cada cliente (plan o paquete vigente).
  @Get('memberships')
  @RequirePermissions('barber:appointments:read')
  memberships(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: ListBarberMembershipsQueryDto,
  ) {
    return this.chargesService.memberships(ctx, query);
  }

  // Quita el plan que cubría una cita (vuelve a cobrarse suelta).
  @Patch('coverage/:appointmentId/remove')
  @RequirePermissions('barber:appointments:write')
  uncover(
    @CurrentTenant() ctx: TenantContext,
    @Param('appointmentId') appointmentId: string,
  ) {
    return this.chargesService.uncover(ctx, appointmentId);
  }

  @Get(':id')
  @RequirePermissions('barber:appointments:read')
  findOne(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.chargesService.findOne(ctx, id);
  }

  @Post()
  @RequirePermissions('barber:appointments:write')
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateBarberChargeDto,
  ) {
    return this.chargesService.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('barber:appointments:write')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBarberChargeDto,
  ) {
    return this.chargesService.update(ctx, id, dto);
  }

  @Post(':id/payments')
  @RequirePermissions('barber:appointments:write')
  addPayment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: BarberPaymentInputDto,
  ) {
    return this.chargesService.addPayment(ctx, id, dto);
  }

  @Post(':id/renew')
  @RequirePermissions('barber:appointments:write')
  renew(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: RenewBarberChargeDto,
  ) {
    return this.chargesService.renew(ctx, id, dto);
  }

  @Patch(':id/freeze')
  @RequirePermissions('barber:appointments:write')
  freeze(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: FreezeBarberChargeDto,
  ) {
    return this.chargesService.freeze(ctx, id, dto);
  }

  // La cita la cubre este plan o paquete.
  @Post(':id/cover')
  @RequirePermissions('barber:appointments:write')
  cover(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CoverAppointmentDto,
  ) {
    return this.chargesService.cover(ctx, id, dto.appointmentId);
  }

  @Patch(':id/void')
  @RequirePermissions('barber:appointments:write')
  voidCharge(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: VoidBarberChargeDto,
  ) {
    return this.chargesService.voidCharge(ctx, id, dto.reason);
  }

  @Patch(':id/payments/:paymentId/void')
  @RequirePermissions('barber:appointments:write')
  voidPayment(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Param('paymentId') paymentId: string,
    @Body() dto: VoidBarberChargeDto,
  ) {
    return this.chargesService.voidPayment(ctx, id, paymentId, dto.reason);
  }
}
