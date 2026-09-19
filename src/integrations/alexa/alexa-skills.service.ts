import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { hashActivationPhrase } from './activation-secret';
import { AlexaSkillRepository } from './alexa-skill.repository';

export interface UpsertAlexaSkillInput {
  applicationId: string;
  label: string;
  /** Null o ausente = skill de plataforma: ve todos los negocios. */
  tenantId?: string | null;
  actingUserId: string;
  ttlDays?: number;
  alexaDeviceId?: string | null;
  isActive?: boolean;
}

/**
 * Administración de skills de Alexa.
 *
 * Hoy solo la usa el backoffice de plataforma (super-admin). Cuando se abra a
 * cada negocio, este servicio no cambia: lo que cambia es quién puede llamarlo
 * y con qué `tenantId` fijo. Los campos ya son por fila.
 * Ver docs/ALEXA_SELF_SERVICE_PLAN.md §5.
 */
@Injectable()
export class AlexaSkillsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: AlexaSkillRepository,
  ) {}

  /** Nunca devuelve el hash de la frase: solo si hay una. */
  private readonly view = {
    id: true,
    applicationId: true,
    label: true,
    tenantId: true,
    actingUserId: true,
    ttlDays: true,
    alexaUserId: true,
    alexaDeviceId: true,
    expiresAt: true,
    isActive: true,
    createdAt: true,
    updatedAt: true,
  } as const;

  private async shape(id: string) {
    const skill = await this.prisma.alexaSkill.findUniqueOrThrow({
      where: { id },
      select: { ...this.view, activationHash: true },
    });
    const { activationHash, ...rest } = skill;
    return { ...rest, hasActivationPhrase: Boolean(activationHash) };
  }

  async list() {
    const skills = await this.prisma.alexaSkill.findMany({
      select: { ...this.view, activationHash: true },
      orderBy: { createdAt: 'asc' },
    });
    return {
      skills: skills.map(({ activationHash, ...rest }) => ({
        ...rest,
        hasActivationPhrase: Boolean(activationHash),
      })),
    };
  }

  async upsert(input: UpsertAlexaSkillInput) {
    const applicationId = input.applicationId.trim();
    if (!applicationId.startsWith('amzn1.ask.skill.')) {
      throw new BadRequestException(
        'El Skill ID debe empezar por amzn1.ask.skill.',
      );
    }
    const ttlDays = input.ttlDays ?? 7;
    if (!Number.isInteger(ttlDays) || ttlDays < 1 || ttlDays > 30) {
      throw new BadRequestException('La duración debe ir entre 1 y 30 días.');
    }
    await this.assertActingUserFits(input.actingUserId, input.tenantId ?? null);

    const data = {
      label: input.label.trim(),
      tenantId: input.tenantId ?? null,
      actingUserId: input.actingUserId,
      ttlDays,
      alexaDeviceId: input.alexaDeviceId?.trim() || null,
      isActive: input.isActive ?? true,
    };
    const skill = await this.prisma.alexaSkill.upsert({
      where: { applicationId },
      create: { applicationId, ...data },
      update: data,
    });
    this.cache.invalidate();
    return this.shape(skill.id);
  }

  /**
   * Define o rota la frase.
   *
   * Rotarla revoca la sesión vigente: si se cambia porque alguien la escuchó,
   * dejar abierta la anterior haría inútil el cambio.
   */
  async setPhrase(id: string, phrase: string) {
    const activationHash = await this.assertPhrase(phrase);
    await this.prisma.alexaSkill.update({
      where: { id },
      data: { activationHash, expiresAt: null, attempts: 0 },
    });
    this.cache.invalidate();
    return this.shape(id);
  }

  /** Cierra la sesión sin tocar la frase ni el vínculo con la cuenta. */
  async revoke(id: string) {
    await this.prisma.alexaSkill.update({
      where: { id },
      data: { expiresAt: null },
    });
    this.cache.invalidate();
    return this.shape(id);
  }

  /** Suelta la cuenta de Amazon para que la próxima activación fije otra. */
  async unlinkAccount(id: string) {
    await this.prisma.alexaSkill.update({
      where: { id },
      data: { alexaUserId: null, expiresAt: null },
    });
    this.cache.invalidate();
    return this.shape(id);
  }

  async remove(id: string) {
    await this.prisma.alexaSkill.delete({ where: { id } });
    this.cache.invalidate();
    return { deleted: true };
  }

  /**
   * La frase se valida acá y no en un DTO porque las reglas viven con el hash:
   * mínimo tres palabras, y sin dígitos. Alexa transcribe "dos mil veintiséis"
   * unas veces como palabras y otras como `2026`, así que una frase con números
   * falla de forma intermitente y parece un bug del producto.
   */
  private async assertPhrase(phrase: string): Promise<string> {
    if (/\d/.test(phrase)) {
      throw new BadRequestException(
        'La frase no puede tener números: Alexa los transcribe de dos maneras distintas.',
      );
    }
    try {
      return await hashActivationPhrase(phrase);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  /** Un usuario no puede responder por un negocio al que no pertenece. */
  private async assertActingUserFits(
    actingUserId: string,
    tenantId: string | null,
  ): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: actingUserId },
      select: { isActive: true, tenantId: true, isPlatformAdmin: true },
    });
    if (!user) throw new NotFoundException('El usuario no existe.');
    if (!user.isActive)
      throw new BadRequestException('El usuario está inactivo.');
    if (!tenantId && !user.isPlatformAdmin) {
      throw new ForbiddenException(
        'Una skill de plataforma exige un usuario de plataforma.',
      );
    }
    if (tenantId && !user.isPlatformAdmin && user.tenantId !== tenantId) {
      throw new ForbiddenException('El usuario no pertenece a ese negocio.');
    }
  }
}
