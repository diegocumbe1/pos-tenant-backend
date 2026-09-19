import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { safeRole, sanitizeEvent, TelemetryContext } from './telemetry.dto';

@Injectable()
export class AssistantTelemetryService {
  private pending = 0;
  constructor(private readonly prisma: PrismaService) {}

  /** Bounded in-flight work; no logging of rejected bodies or database errors. */
  record(
    ctx: TelemetryContext,
    events: unknown,
    channel: 'WEB' | 'ALEXA' = 'WEB',
  ): void {
    try {
      if (
        !ctx.tenantId ||
        !Array.isArray(events) ||
        events.length > 20 ||
        this.pending >= 100
      )
        return;
      const data = events
        .map((e: unknown) => sanitizeEvent(e, ctx, channel))
        .filter(
          (e): e is Prisma.AssistantQueryLogCreateManyInput => e !== null,
        );
      if (!data.length) return;
      this.pending++;
      void Promise.resolve()
        .then(() => this.prisma.assistantQueryLog.createMany({ data }))
        .catch(() => undefined)
        .finally(() => {
          this.pending--;
        });
    } catch {
      /* Telemetry is never part of the response contract. */
    }
  }

  async suggestions(ctx: TelemetryContext, vertical: string) {
    if (!['retail', 'restaurant', 'barber'].includes(vertical)) return [];
    const rows = await this.prisma.assistantQueryLog.groupBy({
      by: ['intentId'],
      where: {
        tenantId: ctx.tenantId,
        role: safeRole(ctx.roleCode),
        vertical,
        resolvedTo: null,
        at: { gte: new Date(Date.now() - 30 * 86400000) },
        outcome: { in: ['ANSWERED', 'NO_DATA'] },
      },
      _count: { _all: true },
      orderBy: { _count: { intentId: 'desc' } },
      take: 20,
    });
    // More than three candidates lets the client apply live feature/permission gates.
    return rows.map((r) => ({ intentId: r.intentId, count: r._count._all }));
  }

  async insights(ctx: TelemetryContext) {
    // All aggregation runs on telemetry only, scoped to one validated tenant and 30 days.
    const since = new Date(Date.now() - 30 * 86400000);
    const where: Prisma.AssistantQueryLogWhereInput = {
      tenantId: ctx.tenantId,
      at: { gte: since },
      resolvedTo: null,
    };
    const [
      total,
      fallbacks,
      top,
      roles,
      signals,
      denied,
      channels,
      latency,
      timeline,
    ] = await Promise.all([
      this.prisma.assistantQueryLog.count({ where }),
      this.prisma.assistantQueryLog.count({
        where: { ...where, outcome: 'FALLBACK' },
      }),
      this.prisma.assistantQueryLog.groupBy({
        by: ['intentId'],
        where,
        _count: { _all: true },
        orderBy: { _count: { intentId: 'desc' } },
      }),
      this.prisma.assistantQueryLog.groupBy({
        by: ['role', 'intentId'],
        where,
        _count: { _all: true },
      }),
      this.prisma.assistantQueryLog.groupBy({
        by: ['resolvedTo'],
        where: {
          ...where,
          resolvedTo: { not: null },
          outcome: { in: ['FALLBACK', 'CLARIFIED'] },
        },
        _count: { _all: true },
        orderBy: { _count: { resolvedTo: 'desc' } },
      }),
      this.prisma.assistantQueryLog.groupBy({
        by: ['intentId'],
        where: { ...where, outcome: 'DENIED_PLAN' },
        _count: { _all: true },
        orderBy: { _count: { intentId: 'desc' } },
      }),
      this.prisma.assistantQueryLog.groupBy({
        by: ['channel'],
        where,
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ p95: number | null }[]>(Prisma.sql`
        SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY "latencyMs") AS p95
        FROM assistant_query_log WHERE "tenantId" = ${ctx.tenantId}
        AND at >= ${since}
        AND "resolvedTo" IS NULL AND "latencyMs" IS NOT NULL`),
      this.prisma.$queryRaw<
        { day: string; count: number; fallbacks: number }[]
      >(Prisma.sql`
        SELECT to_char(at AT TIME ZONE 'UTC' AT TIME ZONE 'America/Bogota', 'YYYY-MM-DD') AS day,
        count(*)::int AS count, count(*) FILTER (WHERE outcome = 'FALLBACK')::int AS fallbacks
        FROM assistant_query_log WHERE "tenantId" = ${ctx.tenantId}
        AND at >= ${since} AND "resolvedTo" IS NULL
        GROUP BY day ORDER BY day`),
    ]);
    return {
      totalQueries: total,
      topIntents: top.map((r) => ({
        intentId: r.intentId,
        count: r._count._all,
        share: total ? r._count._all / total : 0,
      })),
      byRole: roles.map((r) => ({
        role: r.role,
        intentId: r.intentId,
        count: r._count._all,
      })),
      fallbackRate: total ? (100 * fallbacks) / total : 0,
      fallbackSignals: signals.map((r) => ({
        resolvedTo: r.resolvedTo,
        count: r._count._all,
      })),
      deniedByPlan: denied.map((r) => ({
        intentId: r.intentId,
        count: r._count._all,
      })),
      byChannel: channels.map((r) => ({
        channel: r.channel,
        count: r._count._all,
      })),
      p95LatencyMs: Math.round(latency[0]?.p95 ?? 0),
      fallbackTimeline: timeline.map((r) => ({
        ...r,
        rate: r.count ? (100 * r.fallbacks) / r.count : 0,
      })),
    };
  }
}
