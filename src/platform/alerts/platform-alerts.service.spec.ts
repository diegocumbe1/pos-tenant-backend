/* eslint-disable @typescript-eslint/require-await, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access */
import { Prisma } from '@prisma/client';
import { PlatformAlertsService } from './platform-alerts.service';

const NOW = new Date('2026-11-08T15:00:00Z'); // 10 a. m. en Colombia

const sub = (tenantId: string, name: string, due: string, extra = {}) => ({
  tenantId,
  status: 'ACTIVE',
  trialEndsAt: null,
  nextPaymentDueAt: new Date(`${due}T17:00:00Z`),
  currentPeriodEnd: new Date(`${due}T17:00:00Z`),
  graceEndsAt: null,
  tenant: { name },
  ...extra,
});

function build(
  subscriptions: unknown[],
  options: { configured?: boolean } = {},
) {
  const alerts: any[] = [];
  const prisma = {
    subscription: { findMany: jest.fn().mockResolvedValue(subscriptions) },
    platformAlert: {
      create: jest.fn(async ({ data }) => {
        if (
          alerts.some(
            (a) =>
              a.type === data.type &&
              a.tenantId === data.tenantId &&
              a.dueDay === data.dueDay,
          )
        ) {
          throw new Prisma.PrismaClientKnownRequestError('dup', {
            code: 'P2002',
            clientVersion: 'x',
          });
        }
        const row = {
          id: `a${alerts.length + 1}`,
          createdAt: NOW,
          readAt: null,
          ...data,
        };
        alerts.push(row);
        return row;
      }),
      updateMany: jest.fn(async () => ({ count: 1 })),
      findMany: jest.fn(async () => alerts),
      count: jest.fn(async () => alerts.length),
    },
    user: { findMany: jest.fn().mockResolvedValue([{ id: 'admin' }]) },
    platformPushSubscription: {
      findMany: jest
        .fn()
        .mockResolvedValue([
          { id: 'd1', endpoint: 'e', p256dh: 'p', auth: 'a' },
        ]),
      update: jest.fn(),
    },
  };
  const webPush = {
    isConfigured: jest.fn().mockReturnValue(options.configured ?? true),
    getPublicKey: jest.fn().mockReturnValue('key'),
    send: jest.fn().mockResolvedValue({}),
  };
  const service = new PlatformAlertsService(prisma as never, webPush as never);
  return { service, prisma, webPush, alerts };
}

describe('PlatformAlertsService', () => {
  it('avisa 2 días antes y lleva a la cuenta', async () => {
    const { service, webPush, alerts } = build([
      sub('t1', 'Malexca', '2026-11-10'),
    ]);
    expect(await service.run(NOW)).toEqual({ created: 1 });
    expect(alerts[0].type).toBe('billing.due_soon');
    expect(webPush.send.mock.calls[0][1]).toMatchObject({
      title: 'Vence en 2 días: Malexca',
      url: '/admin/tenants/t1',
    });
  });

  it('no repite el mismo aviso aunque corra muchas veces', async () => {
    const { service, webPush } = build([sub('t1', 'Malexca', '2026-11-10')]);
    await service.run(NOW);
    expect(await service.run(NOW)).toEqual({ created: 0 });
    expect(webPush.send).toHaveBeenCalledTimes(1);
  });

  it('al pagar, el vencimiento cambia y no avisa', async () => {
    const { service, webPush } = build([sub('t1', 'Malexca', '2026-12-10')]);
    expect(await service.run(NOW)).toEqual({ created: 0 });
    expect(webPush.send).not.toHaveBeenCalled();
  });

  it('varias del mismo tipo salen en un solo push hacia la lista', async () => {
    const { service, webPush } = build([
      sub('t1', 'A', '2026-11-10'),
      sub('t2', 'B', '2026-11-10'),
    ]);
    await service.run(NOW);
    expect(webPush.send).toHaveBeenCalledTimes(1);
    expect(webPush.send.mock.calls[0][1]).toMatchObject({
      title: '2 cuentas por vencer',
      url: '/admin/alerts',
    });
  });

  it('solo revisa cuentas activas y con suscripción abierta', async () => {
    const { service, prisma } = build([]);
    await service.run(NOW);
    expect(prisma.subscription.findMany.mock.calls[0][0].where).toEqual({
      status: { in: ['TRIALING', 'ACTIVE', 'PAST_DUE'] },
      tenant: { status: 'ACTIVE', deletedAt: null },
    });
  });

  it('no toca la suscripción: avisar no bloquea', async () => {
    const { service, prisma } = build([sub('t1', 'Malexca', '2026-10-01')]);
    await service.run(NOW);
    expect((prisma.subscription as any).update).toBeUndefined();
  });

  it('sin claves de push el aviso queda igual en la consola', async () => {
    const { service, alerts, webPush } = build(
      [sub('t1', 'Malexca', '2026-11-10')],
      {
        configured: false,
      },
    );
    await service.run(NOW);
    expect(alerts).toHaveLength(1);
    expect(webPush.send).not.toHaveBeenCalled();
  });

  it('un dispositivo vencido se desactiva y el resto sigue', async () => {
    const { service, webPush, prisma } = build([
      sub('t1', 'Malexca', '2026-11-10'),
    ]);
    webPush.send.mockRejectedValueOnce(
      Object.assign(new Error('gone'), { statusCode: 410 }),
    );
    await service.run(NOW);
    expect(
      prisma.platformPushSubscription.update.mock.calls[0][0].data.isActive,
    ).toBe(false);
  });

  it('de noche no corre', async () => {
    const { service, prisma } = build([sub('t1', 'Malexca', '2026-11-10')]);
    await service.tick(new Date('2026-11-08T07:00:00Z')); // 2 a. m. en Colombia
    expect(prisma.subscription.findMany).not.toHaveBeenCalled();
  });

  it('la lista marca como resuelto lo que ya pagó', async () => {
    const { service, prisma } = build([sub('t1', 'Malexca', '2026-11-10')]);
    await service.run(NOW);
    prisma.subscription.findMany.mockResolvedValue([
      sub('t1', 'Malexca', '2026-12-10'),
    ]);
    const { alerts } = await service.list();
    expect(alerts[0].open).toBe(false);
  });
});
