import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';

/**
 * Accesos adicionales: una persona que ya tiene su negocio entra también a
 * otro con el mismo correo (switch "Cambiar de negocio").
 *
 * Solo el super-admin los da por ahora: es el caso del cliente que contrata
 * dos verticales. Que el dueño invite un correo existente desde su propio
 * negocio queda para después (ver docs/PLAN_CUENTA_DOS_VERTICALES.md).
 */
@Injectable()
export class TenantMembershipsService {
  private readonly logger = new Logger(TenantMembershipsService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Personas de otro negocio que también entran a éste. */
  async list(tenantId: string) {
    await this.assertTenant(tenantId);
    const rows = await this.prisma.userTenantMembership.findMany({
      where: { tenantId },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        isActive: true,
        createdAt: true,
        role: { select: { code: true, name: true } },
        user: {
          select: {
            id: true,
            email: true,
            name: true,
            tenant: { select: { id: true, name: true } },
          },
        },
      },
    });
    return {
      memberships: rows.map((row) => ({
        id: row.id,
        isActive: row.isActive,
        createdAt: row.createdAt,
        roleCode: row.role.code,
        roleName: row.role.name,
        userId: row.user.id,
        email: row.user.email,
        name: row.user.name,
        primaryTenant: row.user.tenant,
      })),
    };
  }

  /**
   * Da acceso a `tenantId` a quien ya tiene usuario con ese correo.
   *
   * Le asigna todas las sedes del negocio: `TenantGuard` exige que la sede del
   * header sea suya, y un dueño sin sedes asignadas no podría operar.
   */
  async grant(
    tenantId: string,
    input: { email: string; roleCode?: string },
    actorUserId: string,
  ) {
    await this.assertTenant(tenantId);
    const email = input.email.trim().toLowerCase();
    const roleCode = (input.roleCode ?? 'OWNER').trim().toUpperCase();
    if (roleCode === 'ROOT') throw new BadRequestException('Rol no permitido');

    const user = await this.prisma.user.findFirst({
      where: { email: { equals: email, mode: 'insensitive' } },
      select: { id: true, tenantId: true, isPlatformAdmin: true },
    });
    if (!user) {
      throw new NotFoundException(
        'No hay ningún usuario con ese correo. Primero debe existir en su negocio principal.',
      );
    }
    if (user.tenantId === tenantId) {
      throw new ConflictException('Ese correo ya pertenece a este negocio.');
    }
    if (!user.tenantId) {
      throw new BadRequestException(
        'Ese correo es de plataforma, no de un negocio. Usa el modo soporte.',
      );
    }

    const role = await this.prisma.role.findFirst({
      where: { code: roleCode, tenantId },
      select: { id: true, code: true },
    });
    if (!role) {
      throw new BadRequestException(`El negocio no tiene el rol ${roleCode}.`);
    }

    const branches = await this.prisma.branch.findMany({
      where: { tenantId },
      select: { id: true },
    });

    const before = await this.prisma.userTenantMembership.findUnique({
      where: { userId_tenantId: { userId: user.id, tenantId } },
      select: { roleId: true, isActive: true },
    });

    const membership = await this.prisma.$transaction(async (tx) => {
      const saved = await tx.userTenantMembership.upsert({
        where: { userId_tenantId: { userId: user.id, tenantId } },
        create: {
          userId: user.id,
          tenantId,
          roleId: role.id,
          grantedBy: actorUserId,
        },
        update: { roleId: role.id, isActive: true, grantedBy: actorUserId },
        select: { id: true },
      });
      if (branches.length > 0) {
        await tx.userBranch.createMany({
          data: branches.map((b) => ({ userId: user.id, branchId: b.id })),
          skipDuplicates: true,
        });
      }
      return saved;
    });

    await this.audit(actorUserId, 'membership.grant', membership.id, before, {
      userId: user.id,
      tenantId,
      roleCode: role.code,
      isActive: true,
    });
    return { id: membership.id, ok: true };
  }

  /**
   * Quita el acceso. Se desactiva en vez de borrar para conservar quién lo dio;
   * las sedes asignadas se quedan pero no valen sin la membresía activa.
   */
  async revoke(tenantId: string, membershipId: string, actorUserId: string) {
    const membership = await this.prisma.userTenantMembership.findFirst({
      where: { id: membershipId, tenantId },
      select: { id: true, isActive: true },
    });
    if (!membership) throw new NotFoundException('Acceso no encontrado');

    await this.prisma.userTenantMembership.update({
      where: { id: membershipId },
      data: { isActive: false },
    });
    await this.audit(
      actorUserId,
      'membership.revoke',
      membershipId,
      { isActive: membership.isActive },
      { isActive: false },
    );
    return { ok: true };
  }

  /**
   * Vuelve principal este negocio para esa persona e intercambia: el que era su
   * principal queda como acceso adicional, con el mismo rol que tenía.
   *
   * Sirve para el combo en el que paga una sola vertical: el login valida el
   * negocio PRINCIPAL, así que suspender el adicional solo lo bloquea en el
   * switch; suspender el principal la deja sin entrar a ninguno.
   *
   * No mueve datos ni sedes: los dos negocios siguen iguales. El JWT no cambia
   * (se valida contra la base en cada petición), así que aplica en la próxima
   * recarga de la app.
   */
  async makePrimary(
    tenantId: string,
    membershipId: string,
    actorUserId: string,
  ) {
    const membership = await this.prisma.userTenantMembership.findFirst({
      where: { id: membershipId, tenantId },
      select: {
        id: true,
        isActive: true,
        roleId: true,
        userId: true,
        user: {
          select: { tenantId: true, roleId: true, isPlatformAdmin: true },
        },
      },
    });
    if (!membership) throw new NotFoundException('Acceso no encontrado');
    if (!membership.isActive) {
      throw new BadRequestException(
        'Ese acceso está quitado. Reactívalo antes de volverlo principal.',
      );
    }
    const oldPrimaryTenantId = membership.user.tenantId;
    const oldPrimaryRoleId = membership.user.roleId;
    if (!oldPrimaryTenantId || membership.user.isPlatformAdmin) {
      throw new BadRequestException('Esa persona no tiene negocio principal.');
    }
    if (oldPrimaryTenantId === tenantId) {
      throw new ConflictException('Este ya es su negocio principal.');
    }

    await this.prisma.$transaction(async (tx) => {
      // El principal de antes pasa a ser acceso adicional, con su mismo rol.
      await tx.userTenantMembership.upsert({
        where: {
          userId_tenantId: {
            userId: membership.userId,
            tenantId: oldPrimaryTenantId,
          },
        },
        create: {
          userId: membership.userId,
          tenantId: oldPrimaryTenantId,
          roleId: oldPrimaryRoleId,
          grantedBy: actorUserId,
        },
        update: {
          roleId: oldPrimaryRoleId,
          isActive: true,
          grantedBy: actorUserId,
        },
      });
      await tx.user.update({
        where: { id: membership.userId },
        data: { tenantId, roleId: membership.roleId },
      });
      // El principal no vive en memberships: si quedara la fila, saldría dos veces.
      await tx.userTenantMembership.delete({ where: { id: membership.id } });
    });

    await this.audit(
      actorUserId,
      'membership.make_primary',
      membership.id,
      { userId: membership.userId, primaryTenantId: oldPrimaryTenantId },
      { userId: membership.userId, primaryTenantId: tenantId },
    );
    return { ok: true, previousPrimaryTenantId: oldPrimaryTenantId };
  }

  private async assertTenant(tenantId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      select: { id: true },
    });
    if (!tenant) throw new NotFoundException(`Tenant ${tenantId} not found`);
  }

  private async audit(
    actorUserId: string,
    action: string,
    targetId: string,
    before: unknown,
    after: unknown,
  ) {
    try {
      await this.prisma.platformAuditLog.create({
        data: {
          actorUserId,
          action,
          targetType: 'membership',
          targetId,
          before: (before ?? Prisma.JsonNull) as Prisma.InputJsonValue,
          after: (after ?? Prisma.JsonNull) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.warn(`audit ${action} failed: ${(err as Error).message}`);
    }
  }
}
