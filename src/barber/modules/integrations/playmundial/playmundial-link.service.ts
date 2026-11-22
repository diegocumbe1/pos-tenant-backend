import { Injectable, NotFoundException } from '@nestjs/common';
import { TenantContext } from '../../../../auth/types/tenant-context.interface';
import { PrismaService } from '../../../../prisma/prisma.service';
import { generateToken, hashToken } from './playmundial.helpers';

/** Escribir `lastUsedAt` en cada consulta sería una escritura por turno. */
const TOUCH_EVERY_MS = 5 * 60_000;

export type PlayMundialAccess = { tenantId: string; branchId: string };

/**
 * El vínculo de una sede con Play Mundial: crear o rotar el token, revocarlo y
 * reconocerlo cuando Play Mundial lo presenta.
 */
@Injectable()
export class PlayMundialLinkService {
  constructor(private readonly prisma: PrismaService) {}

  async status(ctx: TenantContext) {
    const link = await this.prisma.playMundialLink.findUnique({
      where: { branchId: ctx.branchId },
    });
    if (!link || link.tenantId !== ctx.tenantId) {
      return { linked: false as const };
    }
    return {
      linked: !link.revokedAt,
      revoked: !!link.revokedAt,
      tokenPrefix: link.tokenPrefix,
      createdAt: link.createdAt,
      rotatedAt: link.rotatedAt,
      lastUsedAt: link.lastUsedAt,
    };
  }

  /**
   * Crea el vínculo o ROTA el token (el anterior deja de servir al instante).
   * El token completo se devuelve esta única vez: no se puede volver a ver.
   */
  async issue(ctx: TenantContext) {
    const { token, hash, prefix } = generateToken();
    const existing = await this.prisma.playMundialLink.findUnique({
      where: { branchId: ctx.branchId },
    });
    // La sede es del negocio del contexto, o no hay nada que tocar.
    if (existing && existing.tenantId !== ctx.tenantId) {
      throw new NotFoundException('Sede no encontrada');
    }
    const link = await this.prisma.playMundialLink.upsert({
      where: { branchId: ctx.branchId },
      create: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        tokenHash: hash,
        tokenPrefix: prefix,
        createdById: ctx.userId,
      },
      update: {
        tokenHash: hash,
        tokenPrefix: prefix,
        revokedAt: null,
        rotatedAt: new Date(),
        lastUsedAt: null,
      },
    });
    return { token, tokenPrefix: link.tokenPrefix, rotated: !!existing };
  }

  async revoke(ctx: TenantContext) {
    const { count } = await this.prisma.playMundialLink.updateMany({
      where: { branchId: ctx.branchId, tenantId: ctx.tenantId },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('No hay vínculo en esta sede');
    return { ok: true };
  }

  /** Quién es el dueño de este token, o null si no existe o fue revocado. */
  async authenticate(token: string): Promise<PlayMundialAccess | null> {
    const link = await this.prisma.playMundialLink.findUnique({
      where: { tokenHash: hashToken(token) },
    });
    if (!link || link.revokedAt) return null;
    const stale =
      !link.lastUsedAt ||
      Date.now() - link.lastUsedAt.getTime() > TOUCH_EVERY_MS;
    if (stale) {
      // Si falla no se pierde nada: es solo información para el dueño.
      await this.prisma.playMundialLink
        .update({ where: { id: link.id }, data: { lastUsedAt: new Date() } })
        .catch(() => undefined);
    }
    return { tenantId: link.tenantId, branchId: link.branchId };
  }
}
