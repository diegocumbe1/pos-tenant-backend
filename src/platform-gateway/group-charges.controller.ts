import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
} from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformActor } from '../platform/decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard';
import { GroupChargesService } from './services/group-charges.service';

export class CreateGroupChargeDto {
  @ApiProperty({ example: 1, description: 'Meses que cubre (1, 3, 6 o 12)' })
  @IsInt()
  @Min(1)
  @Max(12)
  termMonths!: number;

  @ApiPropertyOptional({
    enum: ['wompi', 'manual'],
    description: 'wompi = link de pago; manual = Bre-B / transferencia',
  })
  @IsOptional()
  @IsIn(['wompi', 'manual'])
  provider?: 'wompi' | 'manual';

  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  expiresAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  customerEmail?: string;
}

export class GroupManualPaymentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsISO8601()
  paidAt?: string;

  @ApiPropertyOptional({ example: 'transfer' })
  @IsOptional()
  @IsString()
  method?: string;

  @ApiPropertyOptional({ description: 'Número del comprobante' })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  note?: string;
}

/** Cobros del combo: un link o un pago manual por todos los negocios. */
@ApiTags('Platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class GroupChargesController {
  constructor(private readonly charges: GroupChargesService) {}

  @Get('billing-groups/:id/charges')
  list(@Param('id') groupId: string) {
    return this.charges.list(groupId);
  }

  @Post('billing-groups/:id/charges')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Issue the combo charge (one payment link for every business)',
  })
  create(
    @Param('id') groupId: string,
    @Body() dto: CreateGroupChargeDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.charges.create(groupId, dto, actor.id);
  }

  @Post('group-charges/:id/verify')
  verify(@Param('id') id: string) {
    return this.charges.verify(id);
  }

  @Post('group-charges/:id/cancel')
  cancel(@Param('id') id: string) {
    return this.charges.cancel(id);
  }

  @Post('group-charges/:id/manual-payment')
  @ApiOperation({
    summary: 'Register a manual payment (Bre-B, transfer) for the whole combo',
  })
  manual(
    @Param('id') id: string,
    @Body() dto: GroupManualPaymentDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.charges.registerManual(id, dto, actor.id);
  }
}
