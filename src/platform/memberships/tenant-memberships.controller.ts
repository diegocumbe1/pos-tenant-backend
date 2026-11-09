import {
  Body,
  Controller,
  Delete,
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
  ApiPropertyOptional,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength } from 'class-validator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { PlatformActor } from '../decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../guards/platform-admin.guard';
import { TenantMembershipsService } from './tenant-memberships.service';

export class GrantMembershipDto {
  @ApiProperty({ example: 'dueno@negocio.com' })
  @IsEmail()
  email!: string;

  @ApiPropertyOptional({
    example: 'OWNER',
    description: 'Rol en ESTE negocio. Por defecto OWNER.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  roleCode?: string;
}

/** Accesos adicionales de un negocio (una persona, varios negocios). */
@ApiTags('platform')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform/tenants/:id/memberships')
export class TenantMembershipsController {
  constructor(private readonly memberships: TenantMembershipsService) {}

  @Get()
  @ApiOperation({
    summary: 'People from another business who can also enter this one',
  })
  list(@Param('id') id: string) {
    return this.memberships.list(id);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Give an existing email access to this business' })
  grant(
    @Param('id') id: string,
    @Body() dto: GrantMembershipDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.memberships.grant(id, dto, actor.id);
  }

  @Delete(':membershipId')
  @ApiOperation({ summary: 'Remove that access' })
  revoke(
    @Param('id') id: string,
    @Param('membershipId') membershipId: string,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.memberships.revoke(id, membershipId, actor.id);
  }
}
