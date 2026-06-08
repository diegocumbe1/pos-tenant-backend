import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiQuery, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrintJobsService } from './print-jobs.service';
import { CreatePrintJobDto, FailPrintJobDto } from './dto/print-job.dto';

@ApiTags('Print Jobs')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('restaurant/print-jobs')
export class PrintJobsController {
  constructor(private readonly printJobsService: PrintJobsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('restaurant:print:create')
  create(@CurrentTenant() ctx: TenantContext, @Body() dto: CreatePrintJobDto) {
    return this.printJobsService.createFromRequest(ctx, dto);
  }

  @Get()
  @RequirePermissions('restaurant:print:read')
  @ApiQuery({ name: 'status', required: false })
  @ApiQuery({ name: 'from', required: false })
  @ApiQuery({ name: 'to', required: false })
  findAll(
    @CurrentTenant() ctx: TenantContext,
    @Query('status') status?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ) {
    return this.printJobsService.findAll(ctx, status, from, to);
  }

  @Get('pending')
  @RequirePermissions('restaurant:print:read')
  findPending(@CurrentTenant() ctx: TenantContext) {
    return this.printJobsService.findPending(ctx);
  }

  @Post(':id/ack')
  @RequirePermissions('restaurant:print:update')
  ack(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.printJobsService.ack(ctx, id);
  }

  @Post(':id/fail')
  @RequirePermissions('restaurant:print:update')
  fail(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: FailPrintJobDto,
  ) {
    return this.printJobsService.fail(ctx, id, dto.error);
  }

  @Post(':id/retry')
  @RequirePermissions('restaurant:print:update')
  retry(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.printJobsService.retry(ctx, id);
  }
}
