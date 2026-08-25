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
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import {
  RequireAnyPermission,
  RequirePermissions,
} from '../auth/decorators/require-permissions.decorator';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { PermissionsGuard } from '../auth/guards/permissions.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';
import {
  CreateRoleDto,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/role.dto';
import { TenantInviteUserDto, UpdateUserDto } from './dto/user.dto';
import { UpdateTenantDto } from './dto/tenant.dto';
import { TenantAdminService } from './tenant-admin.service';

@ApiTags('TenantAdmin')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard, PermissionsGuard)
@Controller('tenant')
export class TenantAdminController {
  constructor(private readonly service: TenantAdminService) {}

  // ─── Tenant (datos del negocio) ──────────────────────────────────────────────

  @Patch()
  @RequirePermissions('restaurant:settings:write')
  updateTenant(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: UpdateTenantDto,
  ) {
    return this.service.updateTenant(ctx.tenantId, dto);
  }

  // ─── Branches ──────────────────────────────────────────────────────────────

  @Post('branches')
  @RequirePermissions('restaurant:settings:write')
  createBranch(@CurrentTenant() ctx: TenantContext, @Body() dto: CreateBranchDto) {
    return this.service.createBranch(ctx.tenantId, dto);
  }

  // Sin @RequirePermissions: cualquier usuario del tenant (cajero/mesero) necesita
  // leer los datos de pago al cobrar. Solo requiere auth + tenant válidos.
  @Get('branches/:id')
  getBranch(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.getBranch(ctx.tenantId, id);
  }

  // Los datos de pago de la sede (llave Bre-B, billeteras, cuenta, QR) los edita
  // el dueño de cualquier vertical: el dato vive en la sede, no en el módulo de
  // restaurante. Exigir el permiso de restaurante dejaba a barbería y retail sin
  // poder guardarlos.
  @Patch('branches/:id')
  @RequireAnyPermission(
    'restaurant:settings:write',
    'barber:settings:write',
    'retail:settings:write',
  )
  updateBranch(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateBranchDto,
  ) {
    return this.service.updateBranch(ctx.tenantId, id, dto);
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  @Get('users')
  @RequirePermissions('restaurant:staff:read')
  listUsers(@CurrentTenant() ctx: TenantContext) {
    return this.service.listUsers(ctx.tenantId);
  }

  @Post('users/invite')
  @RequirePermissions('admin:users:invite')
  inviteUser(
    @CurrentTenant() ctx: TenantContext,
    @Body() dto: TenantInviteUserDto,
  ) {
    return this.service.inviteUser(ctx.tenantId, dto);
  }

  @Patch('users/:id')
  @RequirePermissions('admin:users:invite')
  updateUser(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateUserDto,
  ) {
    return this.service.updateUser(ctx.tenantId, id, dto);
  }

  @Delete('users/:id')
  @RequirePermissions('admin:users:invite')
  deactivateUser(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.deactivateUser(ctx.tenantId, id);
  }

  // ─── Roles & Permissions ───────────────────────────────────────────────────

  @Get('permissions')
  @RequirePermissions('admin:roles:manage')
  permissionsCatalog() {
    return this.service.listPermissionsCatalog();
  }

  @Get('roles')
  @RequirePermissions('admin:roles:manage')
  rolesMatrix(@CurrentTenant() ctx: TenantContext) {
    return this.service.getRolesMatrix(ctx.tenantId);
  }

  @Post('roles')
  @RequirePermissions('admin:roles:manage')
  createRole(@CurrentTenant() ctx: TenantContext, @Body() dto: CreateRoleDto) {
    return this.service.createCustomRole(ctx.tenantId, dto);
  }

  @Patch('roles/:id')
  @RequirePermissions('admin:roles:manage')
  updateRole(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ) {
    return this.service.updateRole(ctx.tenantId, id, dto);
  }

  @Patch('roles/:id/permissions')
  @RequirePermissions('admin:roles:manage')
  setRolePermissions(
    @CurrentTenant() ctx: TenantContext,
    @Param('id') id: string,
    @Body() dto: SetRolePermissionsDto,
  ) {
    return this.service.setRolePermissions(ctx.tenantId, id, dto);
  }

  @Delete('roles/:id')
  @RequirePermissions('admin:roles:manage')
  deleteRole(@CurrentTenant() ctx: TenantContext, @Param('id') id: string) {
    return this.service.deleteRole(ctx.tenantId, id);
  }
}
