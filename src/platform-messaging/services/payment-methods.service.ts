import { Injectable, NotFoundException } from '@nestjs/common';
import { PlatformPaymentMethod } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpsertPaymentMethodDto } from '../dto/platform-messaging.dto';

@Injectable()
export class PaymentMethodsService {
  constructor(private readonly prisma: PrismaService) {}

  list(includeInactive = true) {
    return this.prisma.platformPaymentMethod.findMany({
      where: includeInactive ? {} : { isActive: true },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async create(dto: UpsertPaymentMethodDto) {
    if (dto.isDefault) await this.clearDefault();
    return this.prisma.platformPaymentMethod.create({ data: { ...dto } });
  }

  async update(id: string, dto: Partial<UpsertPaymentMethodDto>) {
    const existing = await this.prisma.platformPaymentMethod.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException(`Medio de pago no encontrado: ${id}`);
    if (dto.isDefault) await this.clearDefault(id);
    return this.prisma.platformPaymentMethod.update({ where: { id }, data: dto });
  }

  async remove(id: string) {
    await this.prisma.platformPaymentMethod.delete({ where: { id } }).catch(() => {
      throw new NotFoundException(`Medio de pago no encontrado: ${id}`);
    });
  }

  private clearDefault(exceptId?: string) {
    return this.prisma.platformPaymentMethod.updateMany({
      where: exceptId ? { id: { not: exceptId } } : {},
      data: { isDefault: false },
    });
  }

  /** El que se usa en los mensajes: el marcado por defecto, o el primero activo. */
  async primary(): Promise<PlatformPaymentMethod | null> {
    const active = await this.list(false);
    return active.find((m) => m.isDefault) ?? active[0] ?? null;
  }

  /** Bloque `{{medios_pago}}` en texto plano (WhatsApp). */
  renderText(methods: PlatformPaymentMethod[]): string {
    if (methods.length === 0) return '';
    return methods
      .map((m) => {
        const lines = [`*Cómo pagar · ${m.label}*`];
        if (m.reference) lines.push(`🔑 ${this.referenceLabel(m)}: *${m.reference}*`);
        if (m.holder) lines.push(`👤 Titular: ${m.holder}`);
        if (m.bank && m.kind !== 'breb') lines.push(`🏦 ${m.bank}`);
        if (m.instructions) lines.push(m.instructions);
        return lines.join('\n');
      })
      .join('\n\n');
  }

  /** Bloque `{{medios_pago}}` en HTML (correo), con el QR embebido si lo hay. */
  renderHtml(methods: PlatformPaymentMethod[]): string {
    if (methods.length === 0) return '';
    return methods
      .map((m) => {
        const rows: string[] = [
          `<p style="margin:0 0 8px;font-weight:600;color:#111">Cómo pagar · ${escapeHtml(m.label)}</p>`,
        ];
        if (m.reference) {
          rows.push(
            `<p style="margin:0 0 4px">${escapeHtml(this.referenceLabel(m))}: <strong>${escapeHtml(m.reference)}</strong></p>`,
          );
        }
        if (m.holder) rows.push(`<p style="margin:0 0 4px">Titular: ${escapeHtml(m.holder)}</p>`);
        if (m.bank && m.kind !== 'breb') {
          rows.push(`<p style="margin:0 0 4px">${escapeHtml(m.bank)}</p>`);
        }
        if (m.instructions) {
          rows.push(`<p style="margin:0 0 8px;color:#555">${escapeHtml(m.instructions)}</p>`);
        }
        if (m.qrImageUrl) {
          rows.push(
            `<img src="${escapeHtml(m.qrImageUrl)}" alt="QR de pago" width="200" style="display:block;margin:12px 0;border:1px solid #eee;border-radius:8px" />`,
          );
        }
        return `<div style="margin:16px 0;padding:16px;background:#faf9ff;border:1px solid #ece9fb;border-radius:10px">${rows.join('')}</div>`;
      })
      .join('');
  }

  private referenceLabel(m: PlatformPaymentMethod): string {
    if (m.kind === 'breb') return 'Llave';
    if (m.kind === 'nequi') return 'Nequi';
    if (m.kind === 'link') return 'Link';
    if (m.kind === 'bank_transfer') return 'Cuenta';
    return 'Referencia';
  }
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
