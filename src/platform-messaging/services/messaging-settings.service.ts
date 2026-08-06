import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateMessagingSettingsDto } from '../dto/platform-messaging.dto';
import { SETTINGS_SINGLETON_ID } from '../platform-messaging.constants';

@Injectable()
export class MessagingSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Fila única; se crea sola la primera vez que alguien la pide. */
  get() {
    return this.prisma.platformMessagingSettings.upsert({
      where: { id: SETTINGS_SINGLETON_ID },
      update: {},
      create: { id: SETTINGS_SINGLETON_ID },
    });
  }

  async update(dto: UpdateMessagingSettingsDto) {
    await this.get();
    return this.prisma.platformMessagingSettings.update({
      where: { id: SETTINGS_SINGLETON_ID },
      data: dto,
    });
  }
}
