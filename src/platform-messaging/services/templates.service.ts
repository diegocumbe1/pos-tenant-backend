import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PlatformMessageChannel } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateTemplateDto } from '../dto/platform-messaging.dto';
import { extractVariables, unknownVariables } from '../template-variables';
import { SEED_TEMPLATES } from '../seed-templates';

@Injectable()
export class TemplatesService {
  constructor(private readonly prisma: PrismaService) {}

  list(channel?: PlatformMessageChannel) {
    return this.prisma.platformMessageTemplate.findMany({
      where: channel ? { channel } : {},
      orderBy: [{ key: 'asc' }, { channel: 'asc' }],
    });
  }

  async byKey(key: string, channel: PlatformMessageChannel) {
    const template = await this.prisma.platformMessageTemplate.findFirst({
      where: { key, channel, isActive: true },
    });
    if (!template) {
      throw new NotFoundException(
        `No hay plantilla activa "${key}" para el canal ${channel}`,
      );
    }
    return template;
  }

  async update(id: string, dto: UpdateTemplateDto) {
    const existing = await this.prisma.platformMessageTemplate.findUnique({
      where: { id },
    });
    if (!existing)
      throw new NotFoundException(`Plantilla no encontrada: ${id}`);

    const body = dto.body ?? existing.body;
    this.assertVariablesAreKnown(body);
    if (dto.subject) this.assertVariablesAreKnown(dto.subject);

    return this.prisma.platformMessageTemplate.update({
      where: { id },
      data: {
        ...dto,
        variables: extractVariables(
          `${body} ${dto.subject ?? existing.subject ?? ''}`,
        ),
      },
    });
  }

  /** Devuelve una plantilla del sistema a su texto sembrado. */
  async restore(id: string) {
    const existing = await this.prisma.platformMessageTemplate.findUnique({
      where: { id },
    });
    if (!existing)
      throw new NotFoundException(`Plantilla no encontrada: ${id}`);
    if (!existing.isSystem) {
      throw new ForbiddenException(
        'Solo las plantillas del sistema se pueden restaurar',
      );
    }
    const seed = SEED_TEMPLATES.find(
      (t) => t.key === existing.key && t.channel === existing.channel,
    );
    if (!seed) {
      throw new NotFoundException(
        `No hay versión original de "${existing.key}"`,
      );
    }
    return this.prisma.platformMessageTemplate.update({
      where: { id },
      data: {
        name: seed.name,
        description: seed.description,
        subject: seed.subject ?? null,
        body: seed.body,
        variables: extractVariables(`${seed.body} ${seed.subject ?? ''}`),
      },
    });
  }

  /**
   * Siembra las plantillas del sistema que aún no existan. Idempotente: correrlo
   * de nuevo no pisa lo que el super-admin haya editado.
   */
  async seedMissing() {
    let created = 0;
    for (const seed of SEED_TEMPLATES) {
      const exists = await this.prisma.platformMessageTemplate.findUnique({
        where: { key_channel: { key: seed.key, channel: seed.channel } },
      });
      if (exists) continue;
      await this.prisma.platformMessageTemplate.create({
        data: {
          key: seed.key,
          name: seed.name,
          description: seed.description,
          channel: seed.channel,
          subject: seed.subject,
          body: seed.body,
          variables: extractVariables(`${seed.body} ${seed.subject ?? ''}`),
          isSystem: true,
        },
      });
      created += 1;
    }
    return { created };
  }

  private assertVariablesAreKnown(body: string) {
    const unknown = unknownVariables(body);
    if (unknown.length > 0) {
      throw new BadRequestException(
        `Variables desconocidas: ${unknown.map((v) => `{{${v}}}`).join(', ')}`,
      );
    }
  }
}
