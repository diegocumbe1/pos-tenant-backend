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
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../../auth/guards/password-set.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { PermissionsGuard } from '../../../auth/guards/permissions.guard';
import { RequirePermissions } from '../../../auth/decorators/require-permissions.decorator';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrintersService } from './printers.service';
import {
  CreatePrinterDto,
  PrinterHeartbeatDto,
  UpdatePrinterDto,
} from './dto/printer.dto';

@ApiTags('Printers')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('restaurant/printers')
export class PrintersController {
  constructor(private readonly printersService: PrintersService) {}

  @Get()
  @RequirePermissions('restaurant:printers:read')
  findAll(@CurrentTenant() ctx: TenantContext) {
    return this.printersService.findAll(ctx);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('restaurant:printers:manage')
  create(@CurrentTenant() ctx: TenantContext, @Body() dto: CreatePrinterDto) {
    return this.printersService.create(ctx, dto);
  }

  @Patch(':id')
  @RequirePermissions('restaurant:printers:manage')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdatePrinterDto,
  ) {
    return this.printersService.update(ctx, id, dto);
  }

  @Delete(':id')
  @RequirePermissions('restaurant:printers:manage')
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.printersService.remove(ctx, id);
  }

  /** Encola un ticket de prueba que el agente local (LAN) o el front (USB) imprime. */
  @Post(':id/test-print')
  @HttpCode(HttpStatus.CREATED)
  @RequirePermissions('restaurant:printers:manage')
  testPrint(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.printersService.testPrint(ctx, id);
  }

  /** Heartbeat del agente local: reporta si la impresora LAN respondió por TCP. */
  @Post(':id/heartbeat')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions('restaurant:print:update')
  heartbeat(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: PrinterHeartbeatDto,
  ) {
    return this.printersService.heartbeat(ctx, id, dto.online);
  }
}
