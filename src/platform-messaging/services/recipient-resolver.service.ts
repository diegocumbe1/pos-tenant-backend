import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { normalizePhone } from '../phone.util';

export interface ResolvedRecipient {
  name: string | null;
  /** E.164 sin '+' (formato que espera whatsapp-web.js). */
  whatsapp: string | null;
  email: string | null;
  /** Por qué falta cada canal, para explicarlo en la UI antes de enviar. */
  whatsappSkipReason?: string;
  emailSkipReason?: string;
}

/**
 * A quién se le escribe por cada canal. El orden importa: manda el contacto de
 * cobro marcado como principal; si no hay ninguno cargado se cae al dueño de la
 * cuenta, que es el mínimo que siempre existe.
 */
@Injectable()
export class RecipientResolverService {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(tenantId: string): Promise<ResolvedRecipient> {
    const contacts = await this.prisma.billingContact.findMany({
      where: { tenantId },
      orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
    });
    const contact = contacts[0];

    let name = contact?.name ?? null;
    let rawPhone = contact?.whatsapp ?? contact?.phone ?? null;
    let email = contact?.email ?? null;

    if (!contact || !email) {
      // Fallback: el dueño/admin de la cuenta. Es el único correo que siempre
      // existe, porque es con el que se creó el usuario.
      const owner = await this.prisma.user.findFirst({
        where: {
          tenantId,
          isActive: true,
          role: { code: { in: ['OWNER', 'ADMIN'] } },
        },
        orderBy: { createdAt: 'asc' },
      });
      if (owner) {
        name = name ?? owner.name;
        email = email ?? owner.email;
      }
    }

    const result: ResolvedRecipient = {
      name,
      whatsapp: null,
      email: email ?? null,
    };

    if (rawPhone) {
      try {
        result.whatsapp = normalizePhone(rawPhone);
      } catch {
        result.whatsappSkipReason = `El teléfono "${rawPhone}" no es un número válido`;
      }
    } else {
      result.whatsappSkipReason = contact
        ? 'El contacto de cobro no tiene WhatsApp ni teléfono'
        : 'La cuenta no tiene contacto de cobro cargado';
    }

    if (!result.email) {
      result.emailSkipReason = contact
        ? 'El contacto de cobro no tiene correo'
        : 'La cuenta no tiene contacto de cobro ni dueño con correo';
    }

    return result;
  }
}
