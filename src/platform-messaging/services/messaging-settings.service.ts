import { Injectable } from '@nestjs/common';
import { PlatformMessagingSettings } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateMessagingSettingsDto } from '../dto/platform-messaging.dto';
import { SETTINGS_SINGLETON_ID } from '../platform-messaging.constants';

/** Lo que ve la consola: igual que la fila, pero sin el secreto en claro. */
export type PublicMessagingSettings = Omit<
  PlatformMessagingSettings,
  'resendApiKey'
> & {
  hasApiKey: boolean;
  /** Últimos 4 caracteres, para reconocer cuál está puesta sin exponerla. */
  apiKeyHint: string | null;
};

@Injectable()
export class MessagingSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fila única con el secreto. Solo para uso interno (el canal de correo). */
  get(): Promise<PlatformMessagingSettings> {
    return this.prisma.platformMessagingSettings.upsert({
      where: { id: SETTINGS_SINGLETON_ID },
      update: {},
      create: { id: SETTINGS_SINGLETON_ID },
    });
  }

  /** Versión para la API: nunca devuelve la API key. */
  async getPublic(): Promise<PublicMessagingSettings> {
    const { resendApiKey, ...rest } = await this.get();
    return {
      ...rest,
      hasApiKey: !!resendApiKey,
      apiKeyHint: resendApiKey ? resendApiKey.slice(-4) : null,
    };
  }

  async update(
    dto: UpdateMessagingSettingsDto,
  ): Promise<PublicMessagingSettings> {
    await this.get();

    // La UI no puede mostrar la key guardada, así que manda el campo vacío
    // cuando no la está cambiando. Un string vacío significa "déjala como
    // está", no "bórrala": para borrarla existe `clearApiKey`.
    const { resendApiKey, clearApiKey, ...rest } = dto;
    const keyPatch =
      clearApiKey === true
        ? { resendApiKey: null }
        : resendApiKey
          ? { resendApiKey }
          : {};

    await this.prisma.platformMessagingSettings.update({
      where: { id: SETTINGS_SINGLETON_ID },
      data: { ...rest, ...keyPatch },
    });
    return this.getPublic();
  }
}
