import { ForbiddenException } from '@nestjs/common';
import { AlexaSkill } from '@prisma/client';
import { RequestEnvelope } from 'ask-sdk-model';
import { PrismaService } from '../../prisma/prisma.service';
import { hashActivationPhrase } from './activation-secret';
import { AlexaAuthService } from './alexa-auth.service';

describe('AlexaAuthService', () => {
  const PHRASE = 'la casa tiene ventanas azules';
  const envelope = {
    context: { System: { user: { userId: 'amazon-1' } } },
  } as unknown as RequestEnvelope;
  const future = () => new Date(Date.now() + 86_400_000);
  const row = (over: Partial<AlexaSkill> = {}) =>
    ({
      id: 'sk',
      isActive: true,
      activationHash: hash,
      actingUserId: 'u1',
      alexaUserId: 'amazon-1',
      alexaDeviceId: null,
      expiresAt: null,
      attempts: 0,
      windowStartedAt: new Date(),
      ttlDays: 7,
      ...over,
    }) as AlexaSkill;

  let hash: string;
  let findUnique: jest.Mock;
  let updateMany: jest.Mock;
  let service: AlexaAuthService;

  beforeAll(async () => {
    hash = await hashActivationPhrase(PHRASE);
  });

  beforeEach(() => {
    findUnique = jest.fn().mockResolvedValue(row());
    updateMany = jest.fn().mockResolvedValue({ count: 1 });
    const tx = {
      alexaSkill: {
        update: jest.fn().mockImplementation(() => Promise.resolve(row())),
      },
    };
    service = new AlexaAuthService({
      alexaSkill: { findUnique, updateMany, update: jest.fn() },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'u1',
          isActive: true,
          passwordSetAt: new Date(),
          role: { code: 'OWNER' },
          userBranches: [],
        }),
      },
      $transaction: (run: (t: typeof tx) => unknown) => run(tx),
    } as unknown as PrismaService);
  });

  it('una sesión recién activada vale aunque el caché diga que no hay', async () => {
    const cached = row({ expiresAt: null });
    findUnique.mockResolvedValue(row({ expiresAt: future() }));
    await expect(service.actor(envelope, cached)).resolves.toMatchObject({
      id: 'u1',
    });
  });

  it('una sesión cerrada ya no vale aunque el caché diga que sí', async () => {
    const cached = row({ expiresAt: future() });
    findUnique.mockResolvedValue(row({ expiresAt: null }));
    await expect(service.actor(envelope, cached)).resolves.toBeNull();
  });

  it('verifica contra la frase vigente, no contra la del caché', async () => {
    const cached = row({
      activationHash: await hashActivationPhrase('otra frase vieja cualquiera'),
    });
    await expect(service.activate(envelope, cached, PHRASE)).resolves.toBe(
      'active',
    );
  });

  it('usar la skill renueva los días desde hoy', async () => {
    const expiresAt = new Date(Date.now() + 2 * 86_400_000);
    findUnique.mockResolvedValue(row({ expiresAt }));
    await service.actor(envelope, row());

    const { where, data } = updateMany.mock.calls[0][0];
    expect(where).toEqual({ id: 'sk', expiresAt });
    const days = (data.expiresAt.getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.99);
  });

  it('no escribe en cada frase si acaba de renovar', async () => {
    const expiresAt = new Date(Date.now() + 7 * 86_400_000 - 60_000);
    findUnique.mockResolvedValue(row({ expiresAt }));
    await service.actor(envelope, row());
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('no revive una sesión vencida', async () => {
    findUnique.mockResolvedValue(
      row({ expiresAt: new Date(Date.now() - 1000) }),
    );
    await expect(service.actor(envelope, row())).resolves.toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('si no puede renovar, igual responde', async () => {
    findUnique.mockResolvedValue(
      row({ expiresAt: new Date(Date.now() + 86_400_000) }),
    );
    updateMany.mockRejectedValue(new Error('db'));
    await expect(service.actor(envelope, row())).resolves.toMatchObject({
      id: 'u1',
    });
  });

  it('acertar reinicia los intentos', async () => {
    await service.activate(envelope, row(), PHRASE);
    expect(updateMany.mock.calls[0][0].data.attempts).toBe(0);
  });

  it('una frase equivocada no abre la sesión', async () => {
    await expect(
      service.activate(envelope, row(), 'no es la frase correcta'),
    ).resolves.toBe('invalid');
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('rechaza una skill desactivada aunque siga en caché', async () => {
    findUnique.mockResolvedValue(row({ isActive: false }));
    await expect(service.actor(envelope, row())).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
