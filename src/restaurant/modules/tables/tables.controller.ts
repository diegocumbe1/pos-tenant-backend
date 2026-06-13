import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../../auth/guards/jwt-auth.guard';
import { TenantGuard } from '../../../auth/guards/tenant.guard';
import { CurrentTenant } from '../../../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { TablesService } from './tables.service';
import { CreateTableDto } from './dto/create-table.dto';
import { UpdateTableDto } from './dto/update-table.dto';

@ApiTags('Tables')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@UseGuards(JwtAuthGuard, TenantGuard)
@Controller('restaurant/tables')
export class TablesController {
  constructor(private readonly tablesService: TablesService) {}

  @Get()
  findAll(@CurrentTenant() ctx: TenantContext) {
    return this.tablesService.findAll(ctx);
  }

  @Get('trash')
  findTrash(@CurrentTenant() ctx: TenantContext) {
    return this.tablesService.findTrash(ctx);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@CurrentTenant() ctx: TenantContext, @Body() dto: CreateTableDto) {
    return this.tablesService.create(ctx, dto);
  }

  @Patch(':id')
  update(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateTableDto,
  ) {
    return this.tablesService.update(ctx, id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.tablesService.remove(ctx, id);
  }

  @Patch(':id/restore')
  restore(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.tablesService.restore(ctx, id);
  }

  @Delete(':id/permanent')
  @HttpCode(HttpStatus.NO_CONTENT)
  purge(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.tablesService.purge(ctx, id);
  }
}
