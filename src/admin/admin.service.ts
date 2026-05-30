import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { SupabaseService } from '../supabase/supabase.service';
import { ChangeUserEmailDto } from './dto/change-user-email.dto';
import { CleanupTenantByEmailDto } from './dto/cleanup-tenant-by-email.dto';
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

type CleanupCounts = Record<string, number>;

@Injectable()
export class AdminService {
  private readonly logger = new Logger(AdminService.name);

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

  async cleanupTenantByEmail(dto: CleanupTenantByEmailDto) {
    this.assertTenantCleanupEnvironment();

    const email = dto.email.trim().toLowerCase();
    const shouldDelete = dto.confirm === true && dto.dryRun !== true;

    this.logger.warn(
      `Tenant cleanup requested for email=${email} mode=${shouldDelete ? 'delete' : 'preview'}`,
    );

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, email: true, tenantId: true },
    });

    if (!user) {
      // Sin fila local: puede ser un huérfano que sólo vive en Supabase Auth
      // (típicamente porque un cleanup previo borró la fila local pero no Supabase).
      const supabaseUserId = await this.findSupabaseUserIdByEmail(email);
      if (!supabaseUserId) {
        this.logger.warn(
          `Tenant cleanup aborted: user not found email=${email}`,
        );
        throw new NotFoundException(`User with email ${email} not found`);
      }
      if (!shouldDelete) {
        this.logger.log(
          `Supabase orphan preview email=${email} supabaseUserId=${supabaseUserId}`,
        );
        return {
          mode: 'preview',
          email,
          tenant: null,
          counts: {},
          supabaseOrphan: { userId: supabaseUserId },
        };
      }
      await this.deleteSupabaseUsers([supabaseUserId], email);
      this.logger.warn(
        `Supabase orphan deleted email=${email} supabaseUserId=${supabaseUserId}`,
      );
      return {
        mode: 'supabase-orphan-deleted',
        email,
        tenant: null,
        supabase: { deletedUserIds: [supabaseUserId] },
      };
    }

    const tenantId = user.tenantId;
    if (!tenantId) {
      this.logger.warn(
        `Tenant cleanup aborted: user ${user.id} has no tenantId`,
      );
      throw new BadRequestException(
        `User with email ${email} is not associated with a tenant`,
      );
    }

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, plan: true, createdAt: true },
    });

    if (!tenant) {
      this.logger.warn(
        `Tenant cleanup aborted: tenant not found tenantId=${tenantId} email=${email}`,
      );
      throw new NotFoundException(`Tenant ${tenantId} not found`);
    }

    if (!shouldDelete) {
      const counts = await this.getTenantCleanupCounts(this.prisma, tenantId);
      this.logger.log(
        `Tenant cleanup preview ready tenantId=${tenantId} email=${email} counts=${JSON.stringify(counts)}`,
      );
      return {
        mode: 'preview',
        email,
        tenant,
        counts,
      };
    }

    const tenantUserIds = (
      await this.prisma.user.findMany({
        where: { tenantId },
        select: { id: true },
      })
    ).map((u) => u.id);

    const deleted = await this.prisma.$transaction(
      async (tx) => {
        const counts = await this.getTenantCleanupCounts(tx, tenantId);
        this.logger.warn(
          `Deleting tenant data tenantId=${tenantId} email=${email} counts=${JSON.stringify(counts)}`,
        );

        await tx.userBranch.deleteMany({
          where: {
            OR: [{ user: { tenantId } }, { branch: { tenantId } }],
          },
        });
        await tx.rolePermission.deleteMany({ where: { role: { tenantId } } });

        await tx.barberStaffService.deleteMany({
          where: {
            OR: [{ staff: { tenantId } }, { service: { tenantId } }],
          },
        });
        await tx.barberAppointment.deleteMany({ where: { tenantId } });

        await tx.paymentContribution.deleteMany({
          where: { split: { tenantId } },
        });
        await tx.paymentSplitItem.deleteMany({
          where: { split: { tenantId } },
        });
        await tx.paymentSplit.deleteMany({ where: { tenantId } });

        await tx.kitchenTicketItem.deleteMany({
          where: {
            OR: [{ ticket: { tenantId } }, { product: { tenantId } }],
          },
        });
        await tx.kitchenTicket.deleteMany({ where: { tenantId } });

        await tx.orderItem.deleteMany({
          where: {
            OR: [{ order: { tenantId } }, { product: { tenantId } }],
          },
        });
        await tx.order.deleteMany({ where: { tenantId } });

        await tx.reservation.deleteMany({ where: { tenantId } });
        await tx.recipeLine.deleteMany({ where: { tenantId } });
        await tx.stockMovement.deleteMany({ where: { tenantId } });

        await tx.barberSettings.deleteMany({ where: { tenantId } });
        await tx.barberService.deleteMany({ where: { tenantId } });
        await tx.barberStaff.deleteMany({ where: { tenantId } });
        await tx.barberCustomer.deleteMany({ where: { tenantId } });

        await tx.ingredient.deleteMany({ where: { tenantId } });
        await tx.product.deleteMany({ where: { tenantId } });
        await tx.productCategory.deleteMany({ where: { tenantId } });

        await tx.restaurantTable.deleteMany({ where: { tenantId } });
        await tx.area.deleteMany({ where: { tenantId } });

        await tx.menuPublicConfig.deleteMany({ where: { tenantId } });
        await tx.expense.deleteMany({ where: { tenantId } });
        await tx.payroll.deleteMany({ where: { tenantId } });
        await tx.financeGoal.deleteMany({ where: { tenantId } });
        await tx.auditLog.deleteMany({ where: { tenantId } });

        await tx.user.deleteMany({ where: { tenantId } });
        await tx.role.deleteMany({ where: { tenantId } });
        await tx.branch.deleteMany({ where: { tenantId } });
        const tenantDelete = await tx.tenant.deleteMany({
          where: { id: tenantId },
        });

        return { ...counts, tenant: tenantDelete.count };
      },
      { timeout: 60_000, maxWait: 10_000 },
    );

    this.logger.warn(
      `Tenant cleanup completed tenantId=${tenantId} email=${email} deleted=${JSON.stringify(deleted)}`,
    );

    const supabaseResult = await this.deleteSupabaseUsers(
      tenantUserIds,
      email,
    );

    return {
      mode: 'deleted',
      email,
      tenant,
      deleted,
      supabase: supabaseResult,
    };
  }

  async changeUserEmail(dto: ChangeUserEmailDto) {
    const oldEmail = dto.oldEmail.trim().toLowerCase();
    const newEmail = dto.newEmail.trim().toLowerCase();

    if (oldEmail === newEmail) {
      throw new BadRequestException('oldEmail and newEmail are identical');
    }

    this.logger.warn(
      `User email change requested oldEmail=${oldEmail} newEmail=${newEmail}`,
    );

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: oldEmail, mode: 'insensitive' } },
      select: {
        id: true,
        email: true,
        name: true,
        tenantId: true,
        role: { select: { code: true } },
      },
    });
    if (!user) {
      throw new NotFoundException(`User with email ${oldEmail} not found`);
    }

    const localConflict = await this.prisma.user.findFirst({
      where: {
        email: { equals: newEmail, mode: 'insensitive' },
        NOT: { id: user.id },
      },
      select: { id: true },
    });
    if (localConflict) {
      throw new ConflictException(
        `Email already in use locally: ${newEmail}`,
      );
    }

    const supabaseConflictId = await this.findSupabaseUserIdByEmail(newEmail);
    if (supabaseConflictId && supabaseConflictId !== user.id) {
      throw new ConflictException(
        `Email already registered in Supabase Auth: ${newEmail}`,
      );
    }

    await this.supabase.updateUserEmail(user.id, newEmail);

    try {
      await this.prisma.user.update({
        where: { id: user.id },
        data: { email: newEmail },
      });
    } catch (err) {
      this.logger.error(
        `Local email update failed userId=${user.id} email=${newEmail}; rolling back Supabase`,
      );
      try {
        await this.supabase.updateUserEmail(user.id, oldEmail);
      } catch (rollbackErr) {
        const msg =
          rollbackErr instanceof Error
            ? rollbackErr.message
            : String(rollbackErr);
        this.logger.error(
          `Supabase email rollback FAILED userId=${user.id}: ${msg}. Manual intervention required.`,
        );
      }
      throw err;
    }

    this.logger.warn(
      `User email change completed userId=${user.id} oldEmail=${oldEmail} newEmail=${newEmail}`,
    );

    return {
      ok: true,
      userId: user.id,
      oldEmail,
      newEmail,
      user: {
        id: user.id,
        name: user.name,
        tenantId: user.tenantId,
        roleCode: user.role?.code,
      },
    };
  }

  private async findSupabaseUserIdByEmail(
    email: string,
  ): Promise<string | null> {
    const target = email.toLowerCase();
    const perPage = 200;
    for (let page = 1; page < 50; page += 1) {
      const { data, error } = await this.supabase.admin.auth.admin.listUsers({
        page,
        perPage,
      });
      if (error) {
        this.logger.error(`Supabase listUsers failed: ${error.message}`);
        return null;
      }
      const match = data.users.find(
        (u) => u.email?.toLowerCase() === target,
      );
      if (match) return match.id;
      if (data.users.length < perPage) return null;
    }
    return null;
  }

  private async deleteSupabaseUsers(userIds: string[], email: string) {
    const deletedUserIds: string[] = [];
    const failures: Array<{ userId: string; error: string }> = [];
    for (const userId of userIds) {
      try {
        await this.supabase.deleteUser(userId);
        deletedUserIds.push(userId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.logger.error(
          `Supabase deleteUser failed userId=${userId} email=${email}: ${message}`,
        );
        failures.push({ userId, error: message });
      }
    }
    return { deletedUserIds, failures };
  }

  private assertTenantCleanupEnvironment() {
    const env = process.env.APP_ENV ?? process.env.NODE_ENV;
    if (env === 'production') {
      throw new ForbiddenException(
        'Tenant cleanup endpoint is disabled in production',
      );
    }
    if (env !== 'development' && env !== 'staging') {
      throw new ForbiddenException(
        `Tenant cleanup endpoint is only available in development/staging. Current environment: ${env ?? 'undefined'}`,
      );
    }
  }

  private async getTenantCleanupCounts(
    prisma: Prisma.TransactionClient | PrismaService,
    tenantId: string,
  ): Promise<CleanupCounts> {
    const [
      userBranches,
      rolePermissions,
      users,
      roles,
      branches,
      barberStaffServices,
      barberAppointments,
      barberSettings,
      barberServices,
      barberStaff,
      barberCustomers,
      paymentContributions,
      paymentSplitItems,
      paymentSplits,
      kitchenTicketItems,
      kitchenTickets,
      orderItems,
      orders,
      reservations,
      recipeLines,
      stockMovements,
      ingredients,
      products,
      productCategories,
      restaurantTables,
      areas,
      menuPublicConfigs,
      expenses,
      payrolls,
      financeGoals,
      auditLogs,
    ] = await Promise.all([
      prisma.userBranch.count({
        where: {
          OR: [{ user: { tenantId } }, { branch: { tenantId } }],
        },
      }),
      prisma.rolePermission.count({ where: { role: { tenantId } } }),
      prisma.user.count({ where: { tenantId } }),
      prisma.role.count({ where: { tenantId } }),
      prisma.branch.count({ where: { tenantId } }),
      prisma.barberStaffService.count({
        where: {
          OR: [{ staff: { tenantId } }, { service: { tenantId } }],
        },
      }),
      prisma.barberAppointment.count({ where: { tenantId } }),
      prisma.barberSettings.count({ where: { tenantId } }),
      prisma.barberService.count({ where: { tenantId } }),
      prisma.barberStaff.count({ where: { tenantId } }),
      prisma.barberCustomer.count({ where: { tenantId } }),
      prisma.paymentContribution.count({ where: { split: { tenantId } } }),
      prisma.paymentSplitItem.count({ where: { split: { tenantId } } }),
      prisma.paymentSplit.count({ where: { tenantId } }),
      prisma.kitchenTicketItem.count({
        where: {
          OR: [{ ticket: { tenantId } }, { product: { tenantId } }],
        },
      }),
      prisma.kitchenTicket.count({ where: { tenantId } }),
      prisma.orderItem.count({
        where: {
          OR: [{ order: { tenantId } }, { product: { tenantId } }],
        },
      }),
      prisma.order.count({ where: { tenantId } }),
      prisma.reservation.count({ where: { tenantId } }),
      prisma.recipeLine.count({ where: { tenantId } }),
      prisma.stockMovement.count({ where: { tenantId } }),
      prisma.ingredient.count({ where: { tenantId } }),
      prisma.product.count({ where: { tenantId } }),
      prisma.productCategory.count({ where: { tenantId } }),
      prisma.restaurantTable.count({ where: { tenantId } }),
      prisma.area.count({ where: { tenantId } }),
      prisma.menuPublicConfig.count({ where: { tenantId } }),
      prisma.expense.count({ where: { tenantId } }),
      prisma.payroll.count({ where: { tenantId } }),
      prisma.financeGoal.count({ where: { tenantId } }),
      prisma.auditLog.count({ where: { tenantId } }),
    ]);

    return {
      users,
      branches,
      roles,
      rolePermissions,
      userBranches,
      barberStaffServices,
      barberAppointments,
      barberSettings,
      barberServices,
      barberStaff,
      barberCustomers,
      paymentContributions,
      paymentSplitItems,
      paymentSplits,
      kitchenTicketItems,
      kitchenTickets,
      orderItems,
      orders,
      reservations,
      recipeLines,
      stockMovements,
      ingredients,
      products,
      productCategories,
      restaurantTables,
      areas,
      menuPublicConfigs,
      expenses,
      payrolls,
      financeGoals,
      auditLogs,
    };
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
