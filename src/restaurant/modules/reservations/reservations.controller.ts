import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { ReservationsService } from './reservations.service';
import { CreateReservationDto } from './dto/create-reservation.dto';
import { UpdateReservationDto } from './dto/update-reservation.dto';
import { CancelReservationDto } from './dto/cancel-reservation.dto';

@ApiTags('Reservations')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/reservations')
export class ReservationsController {
  constructor(private readonly reservationsService: ReservationsService) {}

  @Get()
  @ApiQuery({
    name: 'status',
    required: false,
    enum: ['ACTIVE', 'SEATED', 'CANCELLED'],
  })
  @ApiQuery({ name: 'upcoming', required: false, type: Boolean })
  findAll(
    @CurrentTenant() ctx: TenantContext,
    @Query('status') status?: string,
    @Query('upcoming') upcoming?: string,
  ) {
    return this.reservationsService.findAll(
      ctx,
      status,
      upcoming === 'true' || upcoming === '1',
    );
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateReservationDto,
  ) {
    return this.reservationsService.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateReservationDto,
  ) {
    return this.reservationsService.update(ctx, id, dto);
  }

  @Patch(':id/seat')
  seat(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.reservationsService.seat(ctx, id);
  }

  @Patch(':id/cancel')
  cancel(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: CancelReservationDto,
  ) {
    return this.reservationsService.cancel(ctx, id, dto);
  }
}
