import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { AlexaSkill } from '@prisma/client';
import { RequestEnvelope } from 'ask-sdk-model';
import { AuthenticatedUser } from '../../auth/types/tenant-context.interface';
import { PrismaService } from '../../prisma/prisma.service';
import { isActivationHash, verifyActivationPhrase } from './activation-secret';

const WINDOW_MS = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const DAY_MS = 86_400_000;
/** Renovar en cada frase sería una escritura por turno, sin ganar nada. */
const RENEW_EVERY_MS = 60 * 60_000;

@Injectable()
export class AlexaAuthService {
  private readonly logger = new Logger('AlexaAuth');

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Valida que esta cuenta de Amazon pueda usar esta skill.
   *
   * La skill ya viene resuelta por `applicationId`, que Amazon firma. Acá solo
   * queda la cuenta: la primera activación fija `alexaUserId` y a partir de ahí
   * se exige. Confianza en el primer uso — quien sabe la frase se queda con la
   * skill, y otra cuenta con la misma frase ya no entra.
   */
  private assertAllowed(envelope: RequestEnvelope, skill: AlexaSkill): string {
    if (!isActivationHash(skill.activationHash ?? '')) {
      throw new ServiceUnavailableException('Activation phrase is not set');
    }
    const system = envelope.context?.System;
    const alexaUser = system?.user?.userId ?? envelope.session?.user?.userId;
    if (!alexaUser) {
      throw new ForbiddenException('Request without an Alexa account');
    }
    if (skill.alexaUserId && skill.alexaUserId !== alexaUser) {
      throw new ForbiddenException('Alexa account is not allowed');
    }
    if (
      skill.alexaDeviceId &&
      system?.device?.deviceId !== skill.alexaDeviceId
    ) {
      throw new ForbiddenException('Alexa device is not allowed');
    }
    // Una sesión de otra cuenta no puede colarse por el contexto.
    const sessionUser = envelope.session?.user?.userId;
    if (sessionUser && sessionUser !== alexaUser) {
      throw new ForbiddenException('Alexa account mismatch');
    }
    return alexaUser;
  }

  /** Por qué no hay sesión vigente. Se registra para no consultar la base a mano. */
  private explainMissingGrant(skill: AlexaSkill): string {
    if (!skill.activationHash) return 'no activation phrase set';
    if (!skill.expiresAt) return 'never activated or revoked';
    return `expired at ${skill.expiresAt.toISOString()}`;
  }

  /**
   * La fila vigente, nunca la del caché.
   *
   * `AlexaSkillRepository` guarda la skill un minuto, y sirve para enrutar. La
   * sesión no puede salir de ahí: tras activar, Alexa siguió pidiendo el código
   * hasta que el caché venció, y tras "cierra mi acceso" la sesión seguía viva
   * ese mismo minuto. Se paga con una consulta por llave primaria en cada turno.
   */
  private async current(skill: AlexaSkill): Promise<AlexaSkill> {
    const row = await this.prisma.alexaSkill.findUnique({
      where: { id: skill.id },
    });
    if (!row?.isActive) throw new ForbiddenException('Skill is not active');
    return row;
  }

  async actor(
    envelope: RequestEnvelope,
    cached: AlexaSkill,
  ): Promise<AuthenticatedUser | null> {
    const skill = await this.current(cached);
    this.assertAllowed(envelope, skill);
    if (!skill.expiresAt || skill.expiresAt.getTime() <= Date.now()) {
      this.logger.warn(`No active grant: ${this.explainMissingGrant(skill)}`);
      return null;
    }
    const actor = await this.loadActor(skill.actingUserId);
    await this.renew(skill, skill.expiresAt);
    return actor;
  }

  /**
   * Los días se cuentan desde el último uso: el código solo se pide tras
   * `ttlDays` sin usar la skill.
   *
   * `expiresAt` en el where: si "cierra mi acceso" entró mientras tanto, esto no
   * reabre la sesión. Un fallo aquí no le niega la respuesta a nadie, porque la
   * sesión sigue vigente.
   */
  private async renew(skill: AlexaSkill, expiresAt: Date): Promise<void> {
    const renewed = Date.now() + skill.ttlDays * DAY_MS;
    if (renewed - expiresAt.getTime() < RENEW_EVERY_MS) return;
    try {
      await this.prisma.alexaSkill.updateMany({
        where: { id: skill.id, expiresAt },
        data: { expiresAt: new Date(renewed) },
      });
    } catch {
      this.logger.warn('Could not renew the voice session');
    }
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
    cached: AlexaSkill,
    phrase: string,
  ): Promise<'active' | 'invalid' | 'locked'> {
    const skill = await this.current(cached);
    const alexaUser = this.assertAllowed(envelope, skill);
    await this.loadActor(skill.actingUserId);

    // Se reserva el intento antes de verificar la frase, que es cara a
    // propósito: si no, cinco peticiones en paralelo pasarían el límite.
    const ticket = await this.prisma.$transaction(async (tx) => {
      const now = new Date();
      // El update vacío toma el lock de la fila y serializa los intentos
      // simultáneos, incluso entre réplicas.
      let row = await tx.alexaSkill.update({
        where: { id: skill.id },
        data: {},
      });
      if (now.getTime() - row.windowStartedAt.getTime() >= WINDOW_MS) {
        row = await tx.alexaSkill.update({
          where: { id: skill.id },
          data: { attempts: 0, windowStartedAt: now },
        });
      }
      if (row.attempts >= MAX_ATTEMPTS) return null;
      await tx.alexaSkill.update({
        where: { id: skill.id },
        data: { attempts: { increment: 1 } },
      });
      return row.windowStartedAt;
    });
    if (!ticket) return 'locked';

    if (!(await verifyActivationPhrase(phrase, skill.activationHash ?? '')))
      return 'invalid';

    const result = await this.prisma.alexaSkill.updateMany({
      // `windowStartedAt` en el where: si otra petición reinició la ventana
      // mientras verificábamos, este intento ya no vale.
      where: { id: skill.id, windowStartedAt: ticket },
      data: {
        // Quien acierta no acumula intentos: si no, repetir la frase correcta
        // terminaría bloqueándolo quince minutos.
        attempts: 0,
        expiresAt: new Date(Date.now() + skill.ttlDays * DAY_MS),
        // Primera activación: la cuenta queda pegada a la skill.
        ...(skill.alexaUserId ? {} : { alexaUserId: alexaUser }),
      },
    });
    return result.count ? 'active' : 'invalid';
  }

  /**
   * Revoca la autorización vigente y nada más.
   *
   * No toca `attempts` ni `windowStartedAt` en ninguna dirección: subirlos
   * bloquearía quince minutos a quien acaba de revocar —que es justamente quien
   * sabe la frase—, y bajarlos convertiría "cierra mi acceso" en una forma de
   * reiniciar el contador y seguir probando frases sin límite. Revocar no es un
   * intento de autenticación.
   */
  async logout(envelope: RequestEnvelope, cached: AlexaSkill): Promise<void> {
    const skill = await this.current(cached);
    this.assertAllowed(envelope, skill);
    await this.prisma.alexaSkill.update({
      where: { id: skill.id },
      data: { expiresAt: null },
    });
  }
}
