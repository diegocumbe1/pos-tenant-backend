import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { StaffCompensationService } from './staff-compensation.service';
import { UpsertCompensationDto } from './dto/compensation.dto';
import { UpsertRoleTemplateDto } from './dto/role-template.dto';
import { CreateLedgerEntryDto, LedgerQueryDto } from './dto/ledger.dto';

@ApiTags('Staff Compensation')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
@Controller('staff')
export class StaffCompensationController {
  constructor(private readonly service: StaffCompensationService) {}

  // ── Perfiles de compensación ────────────────────────────────────────────────
  @Get('compensation')
  getProfiles(@CurrentTenant() ctx: TenantContext) {
    return this.service.getProfiles(ctx);
  }

  // OJO: declarar antes de `compensation/:staffId` para que no lo capture como staffId.
  @Get('compensation/role-templates')
  getRoleTemplates(@CurrentTenant() ctx: TenantContext) {
    return this.service.getRoleTemplates(ctx);
  }

  @Put('compensation/role-templates/:role')
  upsertRoleTemplate(
    @CurrentTenant() ctx: TenantContext,
    @Param('role') role: string,
    @Body() dto: UpsertRoleTemplateDto,
  ) {
    return this.service.upsertRoleTemplate(ctx, role, dto);
  }

  @Get('compensation/:staffId')
  getProfile(
    @CurrentTenant() ctx: TenantContext,
    @Param('staffId') staffId: string,
  ) {
    return this.service.getProfile(ctx, staffId);
  }

  @Put('compensation/:staffId')
  upsertProfile(
    @CurrentTenant() ctx: TenantContext,
    @Param('staffId') staffId: string,
    @Body() dto: UpsertCompensationDto,
  ) {
    return this.service.upsertProfile(ctx, staffId, dto);
  }

  // ── Ledger ──────────────────────────────────────────────────────────────────
  @Get('ledger')
  getLedger(
    @CurrentTenant() ctx: TenantContext,
    @Query() query: LedgerQueryDto,
  ) {
    return this.service.getLedger(ctx, query);
  }

  @Post('ledger')
  addLedgerEntry(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: CreateLedgerEntryDto,
  ) {
    return this.service.addLedgerEntry(ctx, dto);
  }

  @Delete('ledger/:id')
  @HttpCode(204)
  deleteLedgerEntry(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
  ) {
    return this.service.deleteLedgerEntry(ctx, id);
  }
}
