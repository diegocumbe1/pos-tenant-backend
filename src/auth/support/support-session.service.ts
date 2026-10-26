import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthenticatedUser } from '../types/tenant-context.interface';

/**
 * Tenant ficticio con el que viaja el super-admin dentro de su consola
 * (ver `AuthService.platformTenantProfile`). No es un negocio: nunca exige sesión.
 */
export const PLATFORM_TENANT_ID = 'platform';

export const SUPPORT_MIN_MINUTES = 15;
export const SUPPORT_MAX_MINUTES = 240;

export type ActiveSupportSession = {
  id: string;
  tenantId: string;
  tenantName: string;
  reason: string;
  startedAt: Date;
  expiresAt: Date;
};

type CacheEntry = { session: ActiveSupportSession | null; cachedAt: number };

// Corto a propósito: el vencimiento se compara contra `expiresAt` en cada
// request, así que el caché solo puede atrasar un cierre hecho desde otra
// instancia. Evita sumar un viaje a la base en cada request del modo soporte.
const CACHE_TTL_MS = 15_000;

const PAGE_SIZE = 25;
const BODY_MAX_CHARS = 4_000;
const SECRET_KEY = /password|token|secret|authorization|^(pin|cvv|otp)$/i;

/**
 * Sesiones de soporte: el super-admin entra a un negocio con motivo y
 * vencimiento, y cada escritura que hace queda registrada.
 *
 * El historial es exclusivo del backoffice; el owner no lo ve ni se le avisa.
 */
@Injectable()
export class SupportSessionService {
  private readonly logger = new Logger(SupportSessionService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly prisma: PrismaService) {}

  /** ¿Este acceso de un super-admin es a un negocio que no es el suyo? */
  isCrossTenant(user: AuthenticatedUser, tenantId: string | undefined): boolean {
    return (
      user.isPlatformAdmin &&
      !!tenantId &&
      tenantId !== PLATFORM_TENANT_ID &&
      tenantId !== user.tenantId
    );
  }

  async findActive(
    actorUserId: string,
    tenantId: string,
  ): Promise<ActiveSupportSession | null> {
    const key = `${actorUserId}:${tenantId}`;
    const now = Date.now();
    const hit = this.cache.get(key);
    const fresh = hit && now - hit.cachedAt < CACHE_TTL_MS;

    let session = fresh ? hit.session : undefined;
    if (session === undefined) {
      session = await this.prisma.supportSession.findFirst({
        where: {
          actorUserId,
          tenantId,
          endedAt: null,
          expiresAt: { gt: new Date(now) },
        },
        orderBy: { startedAt: 'desc' },
        select: {
          id: true,
          tenantId: true,
          tenantName: true,
          reason: true,
          startedAt: true,
          expiresAt: true,
        },
      });
      this.cache.set(key, { session, cachedAt: now });
    }

    return session && session.expiresAt.getTime() > now ? session : null;
  }

  /** Abre una sesión. Un actor tiene una sola sesión viva: la anterior se cierra. */
  async start(
    actor: AuthenticatedUser,
    input: { tenantId: string; reason: string; durationMinutes: number },
  ): Promise<ActiveSupportSession> {
    const reason = input.reason.trim();
    if (reason.length < 10) {
      throw new BadRequestException('Describe el motivo (mínimo 10 caracteres).');
    }
    const minutes = Math.min(
      SUPPORT_MAX_MINUTES,
      Math.max(SUPPORT_MIN_MINUTES, Math.round(input.durationMinutes)),
    );

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: input.tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) throw new NotFoundException('Tenant not found');

    const now = new Date();
    const session = await this.prisma.$transaction(async (tx) => {
      await tx.supportSession.updateMany({
        where: { actorUserId: actor.id, endedAt: null, expiresAt: { gt: now } },
        data: { endedAt: now, endedReason: 'replaced' },
      });
      return tx.supportSession.create({
        data: {
          actorUserId: actor.id,
          actorEmail: actor.email,
          tenantId: tenant.id,
          tenantName: tenant.name,
          reason,
          startedAt: now,
          expiresAt: new Date(now.getTime() + minutes * 60_000),
        },
        select: {
          id: true,
          tenantId: true,
          tenantName: true,
          reason: true,
          startedAt: true,
          expiresAt: true,
        },
      });
    });

    this.invalidateActor(actor.id);
    this.logger.warn(
      `support session ${session.id} opened by ${actor.email} on tenant ${tenant.id} until ${session.expiresAt.toISOString()}`,
    );
    return session;
  }

  async end(sessionId: string) {
    const session = await this.prisma.supportSession.findUnique({
      where: { id: sessionId },
      select: { id: true, actorUserId: true, endedAt: true },
    });
    if (!session) throw new NotFoundException('Support session not found');

    if (!session.endedAt) {
      await this.prisma.supportSession.update({
        where: { id: sessionId },
        data: { endedAt: new Date(), endedReason: 'manual' },
      });
    }
    this.invalidateActor(session.actorUserId);
    return { ok: true, id: sessionId };
  }

  /** Nunca lanza: un fallo de auditoría no puede tumbar la acción que ya se hizo. */
  async recordAction(input: {
    sessionId: string;
    method: string;
    path: string;
    statusCode: number;
    durationMs: number;
    body: unknown;
  }): Promise<void> {
    try {
      const body = sanitizeBody(input.body);
      await this.prisma.supportSessionAction.create({
        data: {
          sessionId: input.sessionId,
          method: input.method,
          path: input.path.slice(0, 500),
          statusCode: input.statusCode,
          durationMs: Math.round(input.durationMs),
          body: body === undefined ? Prisma.JsonNull : (body as Prisma.InputJsonValue),
        },
      });
    } catch (error) {
      this.logger.error(
        `could not record support action for session ${input.sessionId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  async list(filter: { tenantId?: string; cursor?: string }) {
    const where: Prisma.SupportSessionWhereInput = filter.tenantId
      ? { tenantId: filter.tenantId }
      : {};
    if (
      filter.cursor &&
      !(await this.prisma.supportSession.findFirst({
        where: { AND: [where, { id: filter.cursor }] },
        select: { id: true },
      }))
    ) {
      throw new BadRequestException('Invalid support session cursor');
    }

    const rows = await this.prisma.supportSession.findMany({
      where,
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: PAGE_SIZE + 1,
      ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
      include: { _count: { select: { actions: true } } },
    });
    const page = rows.slice(0, PAGE_SIZE);
    const now = Date.now();

    return {
      sessions: page.map(({ _count, ...row }) => ({
        ...row,
        startedAt: row.startedAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
        active: !row.endedAt && row.expiresAt.getTime() > now,
        actionsCount: _count.actions,
      })),
      nextCursor: rows.length > PAGE_SIZE ? page[page.length - 1].id : null,
    };
  }

  async listActions(sessionId: string) {
    const exists = await this.prisma.supportSession.findUnique({
      where: { id: sessionId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Support session not found');

    const actions = await this.prisma.supportSessionAction.findMany({
      where: { sessionId },
      orderBy: { createdAt: 'asc' },
      take: 500,
    });
    return {
      actions: actions.map((action) => ({
        ...action,
        createdAt: action.createdAt.toISOString(),
      })),
    };
  }

  private invalidateActor(actorUserId: string) {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${actorUserId}:`)) this.cache.delete(key);
    }
  }
}

function sanitizeBody(body: unknown): unknown {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'object' && Object.keys(body as object).length === 0) {
    return undefined;
  }

  const clean = redact(body, 0);
  const json = JSON.stringify(clean);
  if (json.length <= BODY_MAX_CHARS) return clean;
  return { truncated: true, preview: json.slice(0, BODY_MAX_CHARS) };
}

function redact(value: unknown, depth: number): unknown {
  if (depth > 6) return '[…]';
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        SECRET_KEY.test(key) ? '[oculto]' : redact(item, depth + 1),
      ]),
    );
  }
  return value;
}
