import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  WHATSAPP_TEMPLATE_DEFINITIONS,
  WHATSAPP_TEMPLATE_KEYS,
  WhatsappTemplateDefinition,
  WhatsappTemplateKey,
  renderWhatsappTemplate,
  whatsappTemplateDefinition,
} from './templates/message-templates';

/** Plantilla tal como la ve el editor: texto vigente + de dónde salió. */
export interface EffectiveWhatsappTemplate {
  key: WhatsappTemplateKey;
  name: string;
  scope: WhatsappTemplateDefinition['scope'];
  audience: WhatsappTemplateDefinition['audience'];
  body: string;
  /** Texto de fábrica, para que "Restaurar" no tenga que adivinarlo. */
  defaultBody: string;
  /** `false` = el negocio lo personalizó. */
  isDefault: boolean;
  enabled: boolean;
  limit: number;
  required: string[];
  variables: string[];
  updatedAt: Date | null;
}

@Injectable()
export class WhatsappTemplatesService {
  private readonly logger = new Logger(WhatsappTemplatesService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** Todas las plantillas del tenant; opcionalmente solo las de un scope. */
  async list(
    tenantId: string,
    scope?: WhatsappTemplateDefinition['scope'],
  ): Promise<EffectiveWhatsappTemplate[]> {
    const rows = await this.prisma.whatsappTemplate.findMany({
      where: { tenantId },
    });
    const byKey = new Map(rows.map((row) => [row.key as WhatsappTemplateKey, row]));

    return WHATSAPP_TEMPLATE_KEYS.filter(
      (key) => !scope || WHATSAPP_TEMPLATE_DEFINITIONS[key].scope === scope,
    ).map((key) => {
      const definition = whatsappTemplateDefinition(key);
      const row = byKey.get(key);
      return {
        key,
        name: definition.name,
        scope: definition.scope,
        audience: definition.audience,
        body: row?.body ?? definition.body,
        defaultBody: definition.body,
        isDefault: !row,
        enabled: row?.enabled ?? true,
        limit: definition.limit,
        required: definition.required,
        variables: definition.variables,
        updatedAt: row?.updatedAt ?? null,
      };
    });
  }

  /**
   * Texto vigente de una plantilla. Si el negocio apagó ese aviso devuelve
   * `null`, que quien envía debe interpretar como "no mandar nada".
   */
  async resolve(
    tenantId: string,
    key: WhatsappTemplateKey,
  ): Promise<{ body: string; enabled: boolean }> {
    const definition = whatsappTemplateDefinition(key);
    const row = await this.prisma.whatsappTemplate.findUnique({
      where: { tenantId_key: { tenantId, key } },
    });
    return {
      body: row?.body ?? definition.body,
      enabled: row?.enabled ?? true,
    };
  }

  /**
   * Renderiza la plantilla vigente con los datos del evento. Devuelve `null`
   * cuando el aviso está apagado, para que el llamador no envíe.
   */
  async render(
    tenantId: string,
    key: WhatsappTemplateKey,
    values: Record<string, string | undefined | null>,
  ): Promise<string | null> {
    const { body, enabled } = await this.resolve(tenantId, key);
    if (!enabled) {
      this.logger.log(`Plantilla ${key} apagada para tenant ${tenantId}`);
      return null;
    }
    const rendered = renderWhatsappTemplate(body, values);
    return rendered.length > 0 ? rendered : null;
  }

  /** Guarda el texto y/o el interruptor. Solo escribe lo que venga en el input. */
  async upsert(
    tenantId: string,
    key: WhatsappTemplateKey,
    input: { body?: string; enabled?: boolean },
    updatedBy?: string,
  ): Promise<EffectiveWhatsappTemplate> {
    const definition = whatsappTemplateDefinition(key);
    const body = input.body?.trim();

    if (body !== undefined) {
      if (body.length === 0) {
        throw new BadRequestException('La plantilla no puede quedar vacía');
      }
      if (body.length > definition.limit) {
        throw new BadRequestException(
          `La plantilla supera el máximo de ${definition.limit} caracteres`,
        );
      }
    }

    await this.prisma.whatsappTemplate.upsert({
      where: { tenantId_key: { tenantId, key } },
      // Al crear la fila hay que materializar el texto: si solo llegó el
      // interruptor, se congela el default vigente como punto de partida.
      create: {
        tenantId,
        key,
        body: body ?? definition.body,
        enabled: input.enabled ?? true,
        updatedBy,
      },
      update: {
        ...(body !== undefined ? { body } : {}),
        ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
        updatedBy,
      },
    });

    const [effective] = await this.list(tenantId).then((all) =>
      all.filter((template) => template.key === key),
    );
    return effective;
  }

  /** Vuelve al default borrando la personalización. */
  async reset(
    tenantId: string,
    key: WhatsappTemplateKey,
  ): Promise<EffectiveWhatsappTemplate> {
    await this.prisma.whatsappTemplate.deleteMany({ where: { tenantId, key } });
    const [effective] = await this.list(tenantId).then((all) =>
      all.filter((template) => template.key === key),
    );
    return effective;
  }
}
