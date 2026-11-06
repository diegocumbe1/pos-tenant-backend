import {
  BadRequestException,
  ConflictException,
  Injectable,
} from '@nestjs/common';
import {
  CLASS_ATTEND_PERMISSION,
  TRAINER_DEFAULT_OFFSETS,
  TRAINER_PERMISSIONS,
  TRAINER_ROLE_CODE,
  TRAINER_ROLE_NAME,
} from '../../../auth/trainer-role';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../prisma/prisma.service';
import { TenantAdminService } from '../../../tenant-admin/tenant-admin.service';
import { BarberTenantHelper } from '../../shared/barber-tenant.helper';
import {
  CreateBarberStaffDto,
  GrantBarberStaffAccessDto,
  UpdateBarberStaffDto,
} from './dto/barber-staff.dto';

@Injectable()
export class BarberStaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
    private readonly tenantAdmin: TenantAdminService,
  ) {}

  async listStaff(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const staff = await this.prisma.barberStaff.findMany({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      include: { services: { include: { service: true } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    const userIds = staff.flatMap((s) => (s.userId ? [s.userId] : []));
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds }, tenantId: ctx.tenantId, isActive: true },
          select: { id: true, email: true, passwordSetAt: true },
        })
      : [];
    const byId = new Map(users.map((user) => [user.id, user]));
    return staff.map((s) => {
      const user = s.userId ? byId.get(s.userId) : undefined;
      return {
        ...s,
        access: user
          ? {
              email: user.email,
              status: user.passwordSetAt ? 'ACTIVE' : 'INVITED',
            }
          : null,
      };
    });
  }

  async createStaff(ctx: TenantContext, dto: CreateBarberStaffDto) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    await this.assertServicesBelongToBranch(ctx, dto.serviceIds ?? []);
    return this.prisma.barberStaff.create({
      data: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        name: dto.name,
        email: dto.email,
        phone: dto.phone,
        avatarUrl: dto.avatarUrl,
        color: dto.color,
        bio: dto.bio,
        sortOrder: dto.sortOrder,
        services: dto.serviceIds
          ? { create: dto.serviceIds.map((serviceId) => ({ serviceId })) }
          : undefined,
      },
      include: { services: { include: { service: true } } },
    });
  }

  async updateStaff(ctx: TenantContext, id: string, dto: UpdateBarberStaffDto) {
    await this.tenantHelper.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    await this.assertServicesBelongToBranch(ctx, dto.serviceIds ?? []);
    if (dto.isActive === false) await this.revokeAccess(ctx, id);

    return this.prisma.$transaction(async (tx) => {
      const staff = await tx.barberStaff.update({
        where: { id },
        data: {
          name: dto.name,
          email: dto.email,
          phone: dto.phone,
          avatarUrl: dto.avatarUrl,
          color: dto.color,
          bio: dto.bio,
          isActive: dto.isActive,
          sortOrder: dto.sortOrder,
        },
      });

      if (dto.serviceIds) {
        await tx.barberStaffService.deleteMany({ where: { staffId: id } });
        await tx.barberStaffService.createMany({
          data: dto.serviceIds.map((serviceId) => ({ staffId: id, serviceId })),
          skipDuplicates: true,
        });
      }

      return staff;
    });
  }

  async deleteStaff(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    // Quien se va del equipo deja de entrar.
    await this.revokeAccess(ctx, id);
    await this.prisma.barberStaff.update({
      where: { id },
      data: { isActive: false },
    });
    return { ok: true };
  }

  /**
   * Le da usuario propio a un entrenador, como al cajero en restaurante. Solo en
   * gimnasios: el rol se crea aquí, así que barberías y canchas nunca lo tienen.
   */
  async grantAccess(
    ctx: TenantContext,
    id: string,
    dto: GrantBarberStaffAccessDto,
  ) {
    await this.tenantHelper.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    const settings = await this.prisma.barberSettings.findFirst({
      where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      select: { bookingMode: true },
    });
    if (settings?.bookingMode !== 'fitness') {
      throw new BadRequestException(
        'El acceso de entrenador es solo para gimnasios',
      );
    }
    const staff = await this.prisma.barberStaff.findUniqueOrThrow({
      where: { id },
    });
    if (!staff.isActive) {
      throw new BadRequestException('Ese entrenador está desactivado');
    }
    if (staff.userId) {
      throw new ConflictException('Ese entrenador ya tiene acceso');
    }

    const email = dto.email.trim().toLowerCase();
    const roleId = await this.ensureTrainerRole(ctx.tenantId);
    const existing = await this.prisma.user.findUnique({
      where: { email },
      select: { id: true, tenantId: true, roleId: true, isActive: true },
    });
    let userId: string;
    if (existing) {
      // Solo se reutiliza el usuario de un entrenador de este negocio sin ficha.
      const linked = await this.prisma.barberStaff.findFirst({
        where: { userId: existing.id },
        select: { id: true },
      });
      if (
        existing.tenantId !== ctx.tenantId ||
        existing.roleId !== roleId ||
        existing.isActive ||
        linked
      ) {
        throw new ConflictException('Ese correo ya tiene un usuario en Lynko');
      }
      userId = (
        await this.tenantAdmin.reactivateTrainer(
          ctx.tenantId,
          existing.id,
          dto.password,
        )
      ).id;
    } else {
      userId = (
        await this.tenantAdmin.inviteUser(
          ctx.tenantId,
          {
            email,
            name: staff.name,
            roleId,
            branchIds: [staff.branchId],
            password: dto.password,
          },
          { fromTrainerAccess: true },
        )
      ).id;
    }
    await this.prisma.barberStaff.update({
      where: { id },
      data: { userId, email },
    });
    return {
      email,
      status: dto.password ? 'ACTIVE' : existing ? 'ACTIVE' : 'INVITED',
    };
  }

  /** Deja de entrar y se suelta de la ficha. Sus clases y su nómina siguen igual. */
  async revokeAccess(ctx: TenantContext, id: string) {
    await this.tenantHelper.assertScopedRecord('barberStaff', ctx, id, 'Staff');
    const staff = await this.prisma.barberStaff.findUniqueOrThrow({
      where: { id },
      select: { userId: true },
    });
    if (!staff.userId) return { ok: true };
    // Una ficha enlazada a otro rol (el dueño que también atiende) no le quita la cuenta.
    const user = await this.prisma.user.findUnique({
      where: { id: staff.userId },
      select: { role: { select: { code: true } } },
    });
    if (user?.role.code === TRAINER_ROLE_CODE) {
      await this.tenantAdmin.deactivateUser(ctx.tenantId, staff.userId);
    }
    await this.prisma.barberStaff.update({
      where: { id },
      data: { userId: null },
    });
    return { ok: true };
  }

  /** Rol, permisos y aviso de 1 hora antes de cada clase suya. Idempotente. */
  private async ensureTrainerRole(tenantId: string): Promise<string> {
    return this.prisma.$transaction(async (tx) => {
      await tx.permission.upsert({
        where: { code: CLASS_ATTEND_PERMISSION },
        update: {},
        create: {
          code: CLASS_ATTEND_PERMISSION,
          resource: 'barber-classes',
          action: 'attend',
          description: 'Pasar lista en sus clases (rol Entrenador)',
        },
      });
      const permissions = await tx.permission.findMany({
        where: { code: { in: TRAINER_PERMISSIONS } },
        select: { id: true },
      });
      const role = await tx.role.upsert({
        where: { tenantId_code: { tenantId, code: TRAINER_ROLE_CODE } },
        update: {},
        create: {
          tenantId,
          code: TRAINER_ROLE_CODE,
          name: TRAINER_ROLE_NAME,
          isSystem: true,
        },
      });
      await tx.rolePermission.createMany({
        data: permissions.map((p) => ({ roleId: role.id, permissionId: p.id })),
        skipDuplicates: true,
      });
      const rule = await tx.appointmentReminderRule.findFirst({
        where: { tenantId, roleCode: TRAINER_ROLE_CODE },
        select: { id: true },
      });
      if (!rule) {
        await tx.appointmentReminderRule.create({
          data: {
            tenantId,
            roleCode: TRAINER_ROLE_CODE,
            offsetsMinutes: TRAINER_DEFAULT_OFFSETS,
            scope: 'MINE',
          },
        });
      }
      return role.id;
    });
  }

  private async assertServicesBelongToBranch(
    ctx: TenantContext,
    serviceIds: string[],
  ) {
    if (serviceIds.length === 0) return;
    const services = await this.prisma.barberService.findMany({
      where: {
        id: { in: serviceIds },
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
      },
      select: { id: true },
    });
    if (services.length !== serviceIds.length) {
      throw new BadRequestException(
        'Some serviceIds do not belong to this branch',
      );
    }
  }
}
