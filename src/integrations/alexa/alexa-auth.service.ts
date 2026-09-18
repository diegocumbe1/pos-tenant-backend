import {
  ForbiddenException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { RequestEnvelope } from 'ask-sdk-model';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { isActivationHash, verifyActivationPhrase } from './activation-secret';

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;

@Injectable()
export class AlexaAuthService {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  private settings(envelope: RequestEnvelope) {
    const get = (key: string) => this.config.get<string>(key)?.trim() ?? '';
    const hash = get('ALEXA_ACTIVATION_SECRET_HASH');
    const allowed = get('ALEXA_ALLOWED_USER_ID');
    const device = get('ALEXA_ALLOWED_DEVICE_ID');
    const userId = get('ALEXA_LYNKO_USER_ID');
    const ttl = Number(get('ALEXA_AUTH_TTL_DAYS') || '7');
    if (
      !isActivationHash(hash) ||
      !allowed ||
      !userId ||
      !Number.isInteger(ttl) ||
      ttl < 1 ||
      ttl > 30
    ) {
      throw new ServiceUnavailableException(
        'Voice authorization is not configured',
      );
    }
    const system = envelope.context?.System;
    const alexaUser = system?.user?.userId ?? envelope.session?.user?.userId;
    if (
      alexaUser !== allowed ||
      (device && system?.device?.deviceId !== device)
    ) {
      throw new ForbiddenException('Alexa account or device is not allowed');
    }
    if (
      envelope.session?.user?.userId &&
      envelope.session.user.userId !== allowed
    ) {
      throw new ForbiddenException('Alexa account mismatch');
    }
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    return {
      hash,
      userId,
      ttl,
      id: digest(`${get('ALEXA_SKILL_ID')}:${allowed}`),
      configDigest: digest(
        JSON.stringify([hash, allowed, device, userId, ttl]),
      ),
    };
  }

  async actor(envelope: RequestEnvelope): Promise<AuthenticatedUser | null> {
    const settings = this.settings(envelope);
    const grant = await this.prisma.alexaAuthorization.findUnique({
      where: { id: settings.id },
    });
    if (
      !grant ||
      grant.configDigest !== settings.configDigest ||
      !grant.expiresAt ||
      grant.expiresAt.getTime() <= Date.now()
    )
      return null;
    return this.loadActor(settings.userId);
  }

  private async loadActor(id: string): Promise<AuthenticatedUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: { role: true, userBranches: true },
    });
    if (!user?.isActive || (!user.passwordSetAt && user.role.code !== 'ROOT'))
      throw new ForbiddenException('Lynko user is inactive or not provisioned');
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      tenantId: user.tenantId,
      roleId: user.roleId,
      roleCode: user.role.code,
      isRoot: user.role.code === 'ROOT',
      isPlatformAdmin: user.isPlatformAdmin || user.role.code === 'ROOT',
      passwordSetAt: user.passwordSetAt,
      accessibleBranches: user.userBranches.map((b) => b.branchId),
    };
  }

  async activate(
    envelope: RequestEnvelope,
    phrase: string,
  ): Promise<'active' | 'invalid' | 'locked'> {
    const settings = this.settings(envelope);
    await this.loadActor(settings.userId);
    // Reserve an attempt atomically before doing expensive password verification.
    const ticket = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      await tx.alexaAuthorization.upsert({
        where: { id: settings.id },
        create: {
          id: settings.id,
          configDigest: settings.configDigest,
          windowStartedAt: now,
        },
        update: { updatedAt: now }, // row lock serializes activation attempts across replicas
      });
      let row = await tx.alexaAuthorization.findUniqueOrThrow({
        where: { id: settings.id },
      });
      if (
        row.configDigest !== settings.configDigest ||
        now.getTime() - row.windowStartedAt.getTime() >= WINDOW_MS
      ) {
        row = await tx.alexaAuthorization.update({
          where: { id: settings.id },
          data: {
            configDigest: settings.configDigest,
            attempts: 0,
            windowStartedAt: now,
            ...(row.configDigest !== settings.configDigest
              ? { expiresAt: null }
              : {}),
          },
        });
      }
      if (row.attempts >= MAX_ATTEMPTS) return null;
      await tx.alexaAuthorization.update({
        where: { id: settings.id },
        data: { attempts: { increment: 1 } },
      });
      return row.windowStartedAt;
    });
    if (!ticket) return 'locked';
    if (!(await verifyActivationPhrase(phrase, settings.hash)))
      return 'invalid';
    const result = await this.prisma.alexaAuthorization.updateMany({
      where: {
        id: settings.id,
        configDigest: settings.configDigest,
        windowStartedAt: ticket,
      },
      data: { expiresAt: new Date(Date.now() + settings.ttl * 86_400_000) },
    });
    return result.count ? 'active' : 'invalid';
  }

  /**
   * Revoca la autorización vigente y nada más.
   *
   * No toca `attempts` ni `windowStartedAt` a propósito, en las dos
   * direcciones: subirlos bloquearía quince minutos a quien acaba de revocar
   * —que es justamente quien sabe la frase—, y bajarlos convertiría "cierra mi
   * acceso" en una forma de reiniciar el contador y seguir probando frases sin
   * límite. Revocar no es un intento de autenticación.
   */
  async logout(envelope: RequestEnvelope) {
    const settings = this.settings(envelope);
    await this.prisma.alexaAuthorization.updateMany({
      where: { id: settings.id },
      data: {
        expiresAt: null,
      },
    });
  }
}
