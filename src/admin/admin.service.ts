import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { CreateTenantDto } from './dto/create-tenant.dto';
import { UpdateTenantDto } from './dto/update-tenant.dto';

const SYSTEM_ROLE_CODES = [
  'OWNER',
  'MANAGER',
  'CASHIER',
  'WAITER',
  'KITCHEN',
  'ADMIN',
];

@Injectable()
export class AdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supabase: SupabaseService,
  ) {}

  async listTenants() {
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      include: {
        branches: { select: { id: true, name: true } },
        _count: { select: { users: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
    return tenants.map((t) => ({
      id: t.id,
      name: t.name,
      plan: t.plan,
      createdAt: t.createdAt,
      branches: t.branches,
      userCount: t._count.users,
    }));
  }

  async createTenant(dto: CreateTenantDto) {
    const existingEmail = await this.prisma.user.findUnique({
      where: { email: dto.ownerEmail },
    });
    if (existingEmail) {
      throw new ConflictException(`Email already in use: ${dto.ownerEmail}`);
    }

    const tenantId = `tenant-${randomUUID().slice(0, 8)}`;
    const branchId = `branch-${randomUUID().slice(0, 8)}`;

    // 1) Seed tenant + branch + roles sistema en BD
    const tenant = await this.prisma.$transaction(async (tx) => {
      const tenant = await tx.tenant.create({
        data: {
          id: tenantId,
          name: dto.name,
          plan: dto.plan ?? 'BASIC',
        },
      });
      await tx.branch.create({
        data: { id: branchId, tenantId, name: dto.defaultBranchName },
      });
      return tenant;
    });

    // Seed roles sistema para este tenant — hacemos un findMany+create porque
    // necesitamos los permissionIds del catálogo global.
    await this.seedSystemRolesForTenant(tenantId);

    const ownerRole = await this.prisma.role.findUniqueOrThrow({
      where: { tenantId_code: { tenantId, code: 'OWNER' } },
    });

    // 2) Invitar al owner en Supabase
    const supabaseUser = await this.supabase.inviteUser(dto.ownerEmail, {
      tenantId,
      roleId: ownerRole.id,
    });

    // 3) Crear User local + UserBranch
    await this.prisma.user.create({
      data: {
        id: supabaseUser.id,
        tenantId,
        email: dto.ownerEmail,
        name: dto.ownerName,
        roleId: ownerRole.id,
        invitedAt: new Date(),
        userBranches: { create: [{ branchId }] },
      },
    });

    return {
      tenant: { id: tenant.id, name: tenant.name, plan: tenant.plan },
      branch: { id: branchId, name: dto.defaultBranchName },
      owner: {
        id: supabaseUser.id,
        email: dto.ownerEmail,
        status: 'INVITED',
      },
    };
  }

  async updateTenant(id: string, dto: UpdateTenantDto) {
    const tenant = await this.prisma.tenant.findUnique({ where: { id } });
    if (!tenant) throw new NotFoundException(`Tenant ${id} not found`);
    return this.prisma.tenant.update({
      where: { id },
      data: {
        name: dto.name,
        plan: dto.plan,
        deletedAt:
          dto.deleted === true
            ? new Date()
            : dto.deleted === false
              ? null
              : undefined,
      },
    });
  }

  async listBranches(tenantId: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);
    return this.prisma.branch.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Seedea los 6 roles sistema + permisos por matriz para un tenant.
   * Idempotente: se puede llamar varias veces.
   */
  async seedSystemRolesForTenant(tenantId: string) {
    const perms = await this.prisma.permission.findMany();
    if (perms.length === 0) {
      throw new BadRequestException(
        'Permissions catalog empty — run `npm run db:seed` first',
      );
    }
    const permByCode = new Map(perms.map((p) => [p.code, p.id]));
    const restaurantPerms = perms
      .filter((p) => p.code.startsWith('restaurant:'))
      .map((p) => p.code);
    const barberPerms = perms
      .filter((p) => p.code.startsWith('barber:'))
      .map((p) => p.code);

    const matrix: Record<string, { name: string; perms: string[] }> = {
      OWNER: {
        name: 'Dueño',
        perms: [
          ...restaurantPerms,
          ...barberPerms,
          'admin:users:invite',
          'admin:roles:manage',
        ],
      },
      MANAGER: {
        name: 'Gerente',
        perms: [
          ...restaurantPerms.filter((p) => !p.endsWith(':delete')),
          ...barberPerms,
          'admin:users:invite',
        ],
      },
      CASHIER: {
        name: 'Cajero',
        perms: [
          'restaurant:menu:read',
          'restaurant:tables:read',
          'restaurant:orders:read',
          'restaurant:orders:write',
          'restaurant:orders:close',
          'restaurant:payments:read',
          'restaurant:payments:write',
          'restaurant:reservations:read',
        ],
      },
      WAITER: {
        name: 'Mesero',
        perms: [
          'restaurant:menu:read',
          'restaurant:tables:read',
          'restaurant:orders:read',
          'restaurant:orders:write',
          'restaurant:kitchen:read',
          'restaurant:reservations:read',
          'restaurant:reservations:write',
        ],
      },
      KITCHEN: {
        name: 'Cocina',
        perms: [
          'restaurant:orders:read',
          'restaurant:kitchen:read',
          'restaurant:kitchen:write',
        ],
      },
      ADMIN: {
        name: 'Administrativo',
        perms: [
          'restaurant:staff:read',
          'restaurant:staff:write',
          'restaurant:finance:read',
          'restaurant:reservations:read',
          'restaurant:settings:read',
          'restaurant:settings:write',
        ],
      },
    };

    for (const code of SYSTEM_ROLE_CODES) {
      const def = matrix[code];
      const role = await this.prisma.role.upsert({
        where: { tenantId_code: { tenantId, code } },
        update: { name: def.name, isSystem: true },
        create: { tenantId, code, name: def.name, isSystem: true },
      });
      await this.prisma.rolePermission.deleteMany({
        where: { roleId: role.id },
      });
      await this.prisma.rolePermission.createMany({
        data: def.perms
          .map((pcode) => permByCode.get(pcode))
          .filter((id): id is string => !!id)
          .map((permissionId) => ({ roleId: role.id, permissionId })),
        skipDuplicates: true,
      });
    }
  }
}
