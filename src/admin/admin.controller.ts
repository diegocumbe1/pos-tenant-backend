import {
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AdminService } from './admin.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

/**
 * Endpoints ROOT-only para gestión de tenants.
 * No requiere TenantGuard — ROOT trabaja por encima del scope de tenant.
 */
@ApiTags('Admin')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PasswordSetGuard, PermissionsGuard)
@RequirePermissions('admin:tenants:manage')
@Controller('admin/tenants')
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get()
  list() {
    return this.adminService.listTenants();
  }

  @Post()
  create(@Body() dto: CreateTenantDto) {
    return this.adminService.createTenant(dto);
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateTenantDto) {
    return this.adminService.updateTenant(id, dto);
  }

  @Get(':id/branches')
  branches(@Param('id') id: string) {
    return this.adminService.listBranches(id);
  }
}
