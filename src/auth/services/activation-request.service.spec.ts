/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-member-access */
import { ForbiddenException } from '@nestjs/common';
import {
  ActivationRequestService,
  isTenantLocked,
} from './activation-request.service';

const owner = {
  id: 'u1',
  email: 'dueno@x.co',
  name: 'Dueño',
  tenantId: 'rest',
  roleId: 'r1',
  roleCode: 'OWNER',
  isRoot: false,
  isPlatformAdmin: false,
  passwordSetAt: new Date(),
  accessibleBranches: [],
  tenantMemberships: [{ tenantId: 'agenda', roleId: 'r2', roleCode: 'OWNER' }],
} as any;

function build(
  opts: { tenant?: unknown; existing?: unknown; hasVertical?: boolean } = {},
) {
  const prisma: any = {
    tenant: { findFirst: jest.fn().mockResolvedValue(opts.tenant ?? null) },
    user: {
      findFirst: jest
        .fn()
        .mockResolvedValue(opts.hasVertical ? { id: 'u1' } : null),
    },
    platformAlert: {
      findUnique: jest.fn().mockResolvedValue(opts.existing ?? null),
      create: jest.fn().mockResolvedValue({ id: 'a1' }),
      update: jest.fn().mockResolvedValue({}),
    },
    platformPushSubscription: { findMany: jest.fn().mockResolvedValue([]) },
  };
  prisma.user.findMany = jest.fn().mockResolvedValue([]);
  const webPush: any = { isConfigured: () => false, getPublicKey: jest.fn() };
  return { service: new ActivationRequestService(prisma, webPush), prisma };
}

describe('isTenantLocked', () => {
  it('sigue la regla del login', () => {
    expect(
      isTenantLocked({
        status: 'ACTIVE',
        subscription: { status: 'TRIALING' },
      }),
    ).toBe(false);
    expect(
      isTenantLocked({
        status: 'ACTIVE',
        subscription: { status: 'PAST_DUE' },
      }),
    ).toBe(false);
    expect(
      isTenantLocked({
        status: 'SUSPENDED',
        subscription: { status: 'ACTIVE' },
      }),
    ).toBe(true);
    expect(
      isTenantLocked({
        status: 'ACTIVE',
        subscription: { status: 'CANCELED' },
      }),
    ).toBe(true);
    expect(isTenantLocked({ status: 'ACTIVE', subscription: null })).toBe(
      false,
    );
  });
});

describe('ActivationRequestService', () => {
  const lockedAgenda = {
    id: 'agenda',
    name: 'Fase 4 Agenda',
    status: 'SUSPENDED',
    subscription: { status: 'SUSPENDED' },
    vertical: { code: 'barber' },
  };

  it('crea la alerta para el super-admin cuando el negocio está bloqueado', async () => {
    const { service, prisma } = build({ tenant: lockedAgenda });
    const res = await service.requestActivation(owner, 'agenda');
    expect(res).toEqual({
      ok: true,
      alreadyRequested: false,
      nothingToDo: false,
    });
    expect(prisma.platformAlert.create.mock.calls[0][0].data).toMatchObject({
      type: 'activation.requested',
      tenantId: 'agenda',
      url: '/admin/tenants/agenda',
    });
  });

  it('una por día: la segunda vez no vuelve a avisar', async () => {
    const { service, prisma } = build({
      tenant: lockedAgenda,
      existing: { id: 'a0' },
    });
    const res = await service.requestActivation(owner, 'agenda');
    expect(res.alreadyRequested).toBe(true);
    expect(prisma.platformAlert.create).not.toHaveBeenCalled();
  });

  it('no deja pedir por un negocio ajeno', async () => {
    const { service } = build({ tenant: lockedAgenda });
    await expect(
      service.requestActivation(owner, 'otro'),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
