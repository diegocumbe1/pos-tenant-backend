import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsCacheService } from '../auth/services/permissions-cache.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateBranchDto, UpdateBranchDto } from './dto/branch.dto';
import {
  CreateRoleDto,
  RolePermissionItem,
  SetRolePermissionsDto,
  UpdateRoleDto,
} from './dto/role.dto';
import { TenantInviteUserDto, UpdateUserDto } from './dto/user.dto';
import { UpdateTenantDto } from './dto/tenant.dto';

@Injectable()
export class TenantAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
    private readonly permissionsCache: PermissionsCacheService,
  ) {}

  // ─── Branches ──────────────────────────────────────────────────────────────

  async createBranch(tenantId: string, dto: CreateBranchDto) {
    const existing = await this.prisma.branch.findUnique({
      where: { tenantId_name: { tenantId, name: dto.name } },
    });
    if (existing) {
      throw new ConflictException(`Branch name already exists: ${dto.name}`);
    }
    return this.prisma.branch.create({
      data: {
        id: `branch-${randomUUID().slice(0, 8)}`,
        tenantId,
        name: dto.name,
        address: dto.address,
        phone: dto.phone,
      },
    });
  }

  async getBranch(tenantId: string, branchId: string) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch || branch.tenantId !== tenantId) {
      throw new NotFoundException(`Branch ${branchId} not found`);
    }
    return branch;
  }

  async updateBranch(tenantId: string, branchId: string, dto: UpdateBranchDto) {
    const branch = await this.prisma.branch.findUnique({ where: { id: branchId } });
    if (!branch || branch.tenantId !== tenantId) {
      throw new NotFoundException(`Branch ${branchId} not found`);
    }
    // paymentInfo se mergea sobre lo existente (no pisar campos no enviados).
    // El cast a Prisma.InputJsonValue es necesario porque el DTO trae clases
    // (BranchWalletDto[]) y Prisma solo tipa objetos JSON planos.
    const paymentInfo =
      dto.paymentInfo !== undefined
        ? ({
            ...((branch.paymentInfo as Record<string, unknown> | null) ?? {}),
            ...dto.paymentInfo,
          } as Prisma.InputJsonValue)
        : undefined;
    return this.prisma.branch.update({
      where: { id: branchId },
      data: { name: dto.name, address: dto.address, phone: dto.phone, paymentInfo },
    });
  }

  // ─── Tenant (datos del negocio) ──────────────────────────────────────────────

  async updateTenant(tenantId: string, dto: UpdateTenantDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant) {
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }
    const updated = await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { name: dto.name, documentId: dto.documentId },
      select: { id: true, name: true, documentId: true, plan: true, verticalId: true },
    });
    return { tenant: updated };
  }

  // ─── Users ─────────────────────────────────────────────────────────────────

  async listUsers(tenantId: string) {
    const users = await this.prisma.user.findMany({
      where: { tenantId },
      include: {
        role: { select: { id: true, code: true, name: true } },
        userBranches: {
          include: { branch: { select: { id: true, name: true } } },
        },
      },
      orderBy: { createdAt: 'asc' },
    });
    return users.map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      isActive: u.isActive,
      passwordSet: !!u.passwordSetAt,
      invitedAt: u.invitedAt,
      role: u.role,
      branches: u.userBranches.map((ub) => ub.branch),
    }));
  }

  async inviteUser(tenantId: string, dto: TenantInviteUserDto) {
    // Validar rol pertenece al tenant (acepta id o code, ej. "WAITER")
    const role = await this.prisma.role.findFirst({
      where: { tenantId, OR: [{ id: dto.roleId }, { code: dto.roleId }] },
    });
    if (!role) {
      throw new BadRequestException(`Role ${dto.roleId} not found in tenant`);
    }
    if (role.code === 'ROOT') {
      throw new ForbiddenException('Cannot assign ROOT role from tenant scope');
    }

    // Validar branches pertenecen al tenant
    const branches = await this.prisma.branch.findMany({
      where: { id: { in: dto.branchIds }, tenantId },
    });
    if (branches.length !== dto.branchIds.length) {
      throw new BadRequestException('Some branchIds do not belong to tenant');
    }

    // Email único global
    const existingEmail = await this.prisma.user.findUnique({
      where: { email: dto.email },
    });
    if (existingEmail) throw new ConflictException(`Email already in use: ${dto.email}`);

    const appMetadata = { tenantId, roleId: role.id };

    // Modo contraseña temporal: crea el usuario ya confirmado y con clave usable.
    // Modo invitación: envía correo y el usuario define su clave al confirmar.
    let supabaseUser;
    if (dto.password) {
      supabaseUser = await this.supabase.createUser(dto.email, appMetadata);
      await this.supabase.setPassword(supabaseUser.id, dto.password);
    } else {
      supabaseUser = await this.supabase.inviteUser(dto.email, appMetadata);
    }

    const user = await this.prisma.user.create({
      data: {
        id: supabaseUser.id,
        tenantId,
        email: dto.email,
        name: dto.name,
        roleId: role.id,
        invitedAt: new Date(),
        passwordSetAt: dto.password ? new Date() : null,
        userBranches: { create: dto.branchIds.map((branchId) => ({ branchId })) },
      },
    });

    return {
      id: user.id,
      email: user.email,
      status: dto.password ? 'ACTIVE' : 'INVITED',
    };
  }

  async updateUser(tenantId: string, userId: string, dto: UpdateUserDto) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.tenantId !== tenantId) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    if (dto.roleId) {
      const role = await this.prisma.role.findUnique({ where: { id: dto.roleId } });
      if (!role || role.tenantId !== tenantId) {
        throw new BadRequestException('Invalid roleId for tenant');
      }
      if (role.code === 'ROOT') {
        throw new ForbiddenException('Cannot assign ROOT role from tenant scope');
      }
    }

    if (dto.branchIds) {
      const branches = await this.prisma.branch.findMany({
        where: { id: { in: dto.branchIds }, tenantId },
      });
      if (branches.length !== dto.branchIds.length) {
        throw new BadRequestException('Some branchIds do not belong to tenant');
      }
    }

    // Email: solo procesamos si realmente cambió (case-insensitive).
    const normalizedEmail = dto.email?.trim().toLowerCase();
    const emailChanged =
      !!normalizedEmail && normalizedEmail !== user.email.toLowerCase();
    if (emailChanged) {
      const existing = await this.prisma.user.findFirst({
        where: {
          email: { equals: normalizedEmail, mode: 'insensitive' },
          NOT: { id: userId },
        },
        select: { id: true },
      });
      if (existing) {
        throw new ConflictException(`Email already in use: ${normalizedEmail}`);
      }
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: userId },
        data: {
          name: dto.name,
          roleId: dto.roleId,
          email: emailChanged ? normalizedEmail : undefined,
        },
      });
      if (dto.branchIds) {
        await tx.userBranch.deleteMany({ where: { userId } });
        await tx.userBranch.createMany({
          data: dto.branchIds.map((branchId) => ({ userId, branchId })),
          skipDuplicates: true,
        });
      }
    });

    // Sincronizar Supabase Auth: email y/o app_metadata del rol.
    if (emailChanged) {
      await this.supabase.updateUserEmail(userId, normalizedEmail!);
    }
    if (dto.roleId) {
      await this.supabase.setAppMetadata(userId, {
        tenantId,
        roleId: dto.roleId,
      });
    }

    return this.prisma.user.findUniqueOrThrow({
      where: { id: userId },
      include: { role: true, userBranches: true },
    });
  }

  async deactivateUser(tenantId: string, userId: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user || user.tenantId !== tenantId) {
      throw new NotFoundException(`User ${userId} not found`);
    }
    await this.prisma.user.update({
      where: { id: userId },
      data: { isActive: false },
    });
    return { ok: true };
  }

  // ─── Roles & Permissions ───────────────────────────────────────────────────

  async listPermissionsCatalog() {
    return this.prisma.permission.findMany({
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
    });
  }

  // El FE usa ADMINISTRATIVE donde el BE guarda ADMIN.
  private static readonly BE_TO_FE_ROLE_CODE: Record<string, string> = {
    ADMIN: 'ADMINISTRATIVE',
  };

  /**
   * Matriz completa: roles del tenant × permissions, con flag `enabled` por cada par.
   * Usado por la UI "Configuración > Roles y permisos".
   */
  async getRolesMatrix(tenantId: string) {
    const [roles, permissions] = await Promise.all([
      this.prisma.role.findMany({
        where: { tenantId },
        include: { rolePermissions: { select: { permissionId: true } } },
        orderBy: [{ isSystem: 'desc' }, { createdAt: 'asc' }],
      }),
      this.prisma.permission.findMany({
        orderBy: [{ resource: 'asc' }, { action: 'asc' }],
      }),
    ]);

    return {
      permissions: permissions.map((p) => ({
        code: p.code,
        resource: p.resource,
        action: p.action,
        description: p.description,
      })),
      roles: roles.map((r) => {
        const enabled = new Set(r.rolePermissions.map((rp) => rp.permissionId));
        return {
          id: r.id,
          // El FE usa ADMINISTRATIVE donde el BE guarda ADMIN. Exponemos el código FE
          // para que la matriz y el guardado (por id) coincidan con el frontend.
          code: TenantAdminService.BE_TO_FE_ROLE_CODE[r.code] ?? r.code,
          name: r.name,
          isSystem: r.isSystem,
          permissions: permissions.map((p) => ({
            code: p.code,
            enabled: enabled.has(p.id),
          })),
        };
      }),
    };
  }

  async createCustomRole(tenantId: string, dto: CreateRoleDto) {
    const existing = await this.prisma.role.findUnique({
      where: { tenantId_code: { tenantId, code: dto.code } },
    });
    if (existing) throw new ConflictException(`Role code exists: ${dto.code}`);
    if (dto.code === 'ROOT') {
      throw new ForbiddenException('Cannot create ROOT role');
    }
    return this.prisma.role.create({
      data: {
        tenantId,
        code: dto.code,
        name: dto.name,
        isSystem: false,
      },
    });
  }

  async updateRole(tenantId: string, roleId: string, dto: UpdateRoleDto) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.tenantId !== tenantId) {
      throw new NotFoundException(`Role ${roleId} not found`);
    }
    if (role.isSystem) {
      throw new ForbiddenException('Cannot rename a system role');
    }
    return this.prisma.role.update({
      where: { id: roleId },
      data: { name: dto.name },
    });
  }

  // Permisos reservados a ROOT: nunca se asignan desde el scope del tenant.
  private static readonly ROOT_ONLY_PERMISSIONS = new Set(['admin:tenants:manage']);

  /**
   * Actualiza los permisos de un rol. Dos modos:
   *   • Bulk: dto.permissions = set completo del rol → replace-all con los habilitados.
   *   • Legacy: dto.permissionCode + dto.enabled → togglea un solo permiso.
   */
  async setRolePermissions(
    tenantId: string,
    roleId: string,
    dto: SetRolePermissionsDto,
  ) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role || role.tenantId !== tenantId) {
      throw new NotFoundException(`Role ${roleId} not found`);
    }
    if (role.code === 'ROOT') {
      throw new ForbiddenException('Cannot modify ROOT permissions');
    }

    // ── Modo bulk (set completo) ──────────────────────────────────────────────
    if (Array.isArray(dto.permissions)) {
      return this.replaceRolePermissions(roleId, dto.permissions);
    }

    // ── Modo legacy (toggle individual) ───────────────────────────────────────
    if (typeof dto.permissionCode === 'string') {
      return this.toggleSinglePermission(roleId, dto.permissionCode, !!dto.enabled);
    }

    throw new BadRequestException(
      'Envía { permissions: [...] } (bulk) o { permissionCode, enabled } (individual)',
    );
  }

  /** Reemplaza el set de permisos del rol por los que vengan habilitados en `items`. */
  private async replaceRolePermissions(
    roleId: string,
    items: Array<string | RolePermissionItem>,
  ) {
    // Códigos que deben quedar habilitados.
    const desiredCodes = new Set<string>();
    for (const item of items) {
      if (typeof item === 'string') {
        desiredCodes.add(item);
      } else if (item && typeof item === 'object') {
        const code = item.permissionCode ?? item.code;
        // Objeto sin `enabled` → se interpreta como habilitado (lista de habilitados).
        if (code && item.enabled !== false) desiredCodes.add(code);
      }
    }
    // Nunca asignar permisos ROOT-only desde el tenant.
    for (const rootOnly of TenantAdminService.ROOT_ONLY_PERMISSIONS) {
      desiredCodes.delete(rootOnly);
    }

    // Resolver códigos → ids (ignora códigos desconocidos en silencio).
    const permissions = await this.prisma.permission.findMany({
      where: { code: { in: [...desiredCodes] } },
      select: { id: true },
    });

    await this.prisma.$transaction([
      this.prisma.rolePermission.deleteMany({ where: { roleId } }),
      this.prisma.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId, permissionId: p.id })),
        skipDuplicates: true,
      }),
    ]);

    this.permissionsCache.invalidate(roleId);
    return { ok: true, count: permissions.length };
  }

  /** Habilita/deshabilita un único permiso (compat con la API anterior). */
  private async toggleSinglePermission(
    roleId: string,
    permissionCode: string,
    enabled: boolean,
  ) {
    if (TenantAdminService.ROOT_ONLY_PERMISSIONS.has(permissionCode)) {
      throw new ForbiddenException(`${permissionCode} is ROOT-only`);
    }
    const permission = await this.prisma.permission.findUnique({
      where: { code: permissionCode },
    });
    if (!permission) {
      throw new NotFoundException(`Permission ${permissionCode} not found`);
    }

    if (enabled) {
      await this.prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId: permission.id } },
        update: {},
        create: { roleId, permissionId: permission.id },
      });
    } else {
      await this.prisma.rolePermission.deleteMany({
        where: { roleId, permissionId: permission.id },
      });
    }

    this.permissionsCache.invalidate(roleId);
    return { ok: true };
  }

  async deleteRole(tenantId: string, roleId: string) {
    const role = await this.prisma.role.findUnique({
      where: { id: roleId },
      include: { _count: { select: { users: true } } },
    });
    if (!role || role.tenantId !== tenantId) {
      throw new NotFoundException(`Role ${roleId} not found`);
    }
    if (role.isSystem) {
      throw new ForbiddenException('Cannot delete a system role');
    }
    if (role._count.users > 0) {
      throw new UnprocessableEntityException(
        'Cannot delete role with users assigned',
      );
    }
    await this.prisma.role.delete({ where: { id: roleId } });
    this.permissionsCache.invalidate(roleId);
    return { ok: true };
  }
}
