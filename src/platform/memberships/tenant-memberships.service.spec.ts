/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { BadRequestException, ConflictException } from '@nestjs/common';
import { TenantMembershipsService } from './tenant-memberships.service';

function build(membership: unknown) {
  const tx = {
    userTenantMembership: {
      upsert: jest.fn().mockResolvedValue({}),
      delete: jest.fn().mockResolvedValue({}),
    },
    user: { update: jest.fn().mockResolvedValue({}) },
  };
  const prisma: any = {
    userTenantMembership: {
      findFirst: jest.fn().mockResolvedValue(membership),
    },
    platformAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn((fn: (t: typeof tx) => unknown) => fn(tx)),
  };
  return { service: new TenantMembershipsService(prisma), prisma, tx };
}

const membership = (extra = {}) => ({
  id: 'm1',
  isActive: true,
  roleId: 'role-rest-owner',
  userId: 'u1',
  user: {
    tenantId: 'agenda',
    roleId: 'role-agenda-owner',
    isPlatformAdmin: false,
  },
  ...extra,
});

describe('TenantMembershipsService.makePrimary', () => {
  it('intercambia: el negocio pasa a principal y el de antes queda adicional con su rol', async () => {
    const { service, tx } = build(membership());
    const res = await service.makePrimary('restaurante', 'm1', 'admin');

    expect(res).toEqual({ ok: true, previousPrimaryTenantId: 'agenda' });
    expect(tx.userTenantMembership.upsert.mock.calls[0][0]).toMatchObject({
      where: { userId_tenantId: { userId: 'u1', tenantId: 'agenda' } },
      create: { roleId: 'role-agenda-owner' },
      update: { roleId: 'role-agenda-owner', isActive: true },
    });
    expect(tx.user.update.mock.calls[0][0]).toEqual({
      where: { id: 'u1' },
      data: { tenantId: 'restaurante', roleId: 'role-rest-owner' },
    });
    expect(tx.userTenantMembership.delete).toHaveBeenCalledWith({
      where: { id: 'm1' },
    });
  });

  it('no deja volver principal un acceso quitado', async () => {
    const { service, prisma } = build(membership({ isActive: false }));
    await expect(
      service.makePrimary('restaurante', 'm1', 'admin'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('si ya es el principal no hace nada', async () => {
    const { service } = build(
      membership({
        user: { tenantId: 'restaurante', roleId: 'r', isPlatformAdmin: false },
      }),
    );
    await expect(
      service.makePrimary('restaurante', 'm1', 'admin'),
    ).rejects.toBeInstanceOf(ConflictException);
  });
});
