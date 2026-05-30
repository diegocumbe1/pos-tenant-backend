import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBody,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermissions } from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { AdminService } from './admin.service';
import { CleanupTenantByEmailDto } from './dto/cleanup-tenant-by-email.dto';
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

  @Delete('cleanup-by-email')
  @ApiOperation({
    summary: 'Preview or cleanup a tenant resolved from a user email',
    description:
      'Development/staging only. Resolves tenantId from the provided email and deletes all tenant data only when confirm is true and dryRun is not true.',
  })
  @ApiBody({ type: CleanupTenantByEmailDto })
  @ApiOkResponse({
    description:
      'Returns preview counts or deletion counts with tenant information.',
  })
  @ApiNotFoundResponse({ description: 'User or tenant not found.' })
  @ApiForbiddenResponse({
    description: 'Endpoint disabled outside development/staging.',
  })
  cleanupByEmail(@Body() dto: CleanupTenantByEmailDto) {
    return this.adminService.cleanupTenantByEmail(dto);
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
