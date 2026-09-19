import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { CurrentTenant } from '../../auth/decorators/current-tenant.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../auth/guards/password-set.guard';
import { TenantGuard } from '../../auth/guards/tenant.guard';
import { TenantContext } from '../../auth/types/tenant-context.interface';
import { TelemetryBatchDto } from './telemetry.dto';
import { AssistantTelemetryService } from './telemetry.service';

@Controller('assistant')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
export class AssistantTelemetryController {
  constructor(private readonly telemetry: AssistantTelemetryService) {}
  @Post('telemetry')
  @HttpCode(204)
  ingest(
    @CurrentTenant() ctx: TenantContext,
    @Body() body: TelemetryBatchDto,
  ): void {
    try {
      this.telemetry.record(ctx, body?.events);
    } catch {
      /* always 204 after guards */
    }
  }
  @Get('insights')
  insights(@CurrentTenant() ctx: TenantContext) {
    if (!ctx.isRoot && !['OWNER', 'ADMIN'].includes(ctx.roleCode))
      throw new ForbiddenException();
    return this.telemetry.insights(ctx);
  }
  @Get('suggestions')
  suggestions(
    @CurrentTenant() ctx: TenantContext,
    @Query('vertical') vertical: string,
  ) {
    return this.telemetry.suggestions(ctx, vertical);
  }
}
