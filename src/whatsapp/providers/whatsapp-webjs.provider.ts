import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { IMessagingProvider } from './messaging-provider.interface';
import { WhatsAppSessionManager } from '../whatsapp-session.manager';

const normalizePhone = (raw: string): string => {
  const digits = raw.replace(/\s+/g, '').replace(/[^\d]/g, '');
  if (!digits) throw new Error('Phone number is empty after normalization');
  return `${digits}@c.us`;
};

@Injectable()
export class WhatsAppWebJsProvider implements IMessagingProvider {
  constructor(private readonly sessions: WhatsAppSessionManager) {}

  async isReady(tenantId: string, branchId: string): Promise<boolean> {
    return this.sessions.isReady(tenantId, branchId);
  }

  async sendText(input: {
    tenantId: string;
    branchId: string;
    to: string;
    body: string;
  }): Promise<{ id: string }> {
    const { tenantId, branchId, to, body } = input;
    const ready = await this.sessions.isReady(tenantId, branchId);
    if (!ready) {
      throw new ServiceUnavailableException(
        'WhatsApp no conectado para esta sucursal. Escanea el QR en Ajustes.',
      );
    }
    const client = this.sessions.getClient(tenantId, branchId);
    if (!client) {
      throw new ServiceUnavailableException('WhatsApp client not initialized');
    }
    const chatId = normalizePhone(to);
    const message = await client.sendMessage(chatId, body);
    return { id: message.id?._serialized ?? 'unknown' };
  }
}
