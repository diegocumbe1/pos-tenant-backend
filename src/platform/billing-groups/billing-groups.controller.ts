import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
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
  ArrayMinSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { PlatformActor } from '../decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';
import { BillingGroupsService } from './billing-groups.service';

export class CreateBillingGroupDto {
  @ApiProperty({ type: [String], description: 'Negocios del combo (2 o 3)' })
  @IsArray()
  @ArrayMinSize(2)
  @IsString({ each: true })
  tenantIds!: string[];

  @ApiPropertyOptional({
    description: 'Negocio cuyo vencimiento manda y recibe el recordatorio',
  })
  @IsOptional()
  @IsString()
  primaryTenantId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;
}

export class TenantRefDto {
  @ApiProperty()
  @IsString()
  tenantId!: string;
}

/** Combo de verticales: qué negocios se cobran juntos (solo super-admin). */
@ApiTags('Platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class BillingGroupsController {
  constructor(private readonly groups: BillingGroupsService) {}

  @Get('tenants/:id/billing-group')
  @ApiOperation({ summary: 'Combo of this tenant, or null if billed alone' })
  forTenant(@Param('id') tenantId: string) {
    return this.groups.forTenant(tenantId);
  }

  @Post('billing-groups')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a combo with 2 or 3 businesses' })
  create(
    @Body() dto: CreateBillingGroupDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.groups.create(dto, actor.id);
  }

  @Get('billing-groups/:id')
  get(@Param('id') id: string) {
    return this.groups.get(id);
  }

  @Get('billing-groups/:id/quote')
  @ApiOperation({ summary: 'Next combo charge, line by line, with issues' })
  quote(@Param('id') id: string, @Query('termMonths') termMonths?: string) {
    return this.groups.quote(id, Number(termMonths) || 1);
  }

  @Post('billing-groups/:id/tenants')
  addTenant(
    @Param('id') id: string,
    @Body() dto: TenantRefDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.groups.addTenant(id, dto.tenantId, actor.id);
  }

  @Delete('billing-groups/:id/tenants/:tenantId')
  removeTenant(
    @Param('id') id: string,
    @Param('tenantId') tenantId: string,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.groups.removeTenant(id, tenantId, actor.id);
  }

  @Patch('billing-groups/:id/primary')
  setPrimary(
    @Param('id') id: string,
    @Body() dto: TenantRefDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.groups.setPrimary(id, dto.tenantId, actor.id);
  }

  @Delete('billing-groups/:id')
  @ApiOperation({
    summary: 'Dissolve the combo: each business is billed alone again',
  })
  dissolve(@Param('id') id: string, @PlatformActor() actor: AuthenticatedUser) {
    return this.groups.dissolve(id, actor.id);
  }
}
