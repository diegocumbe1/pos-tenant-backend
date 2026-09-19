import { INestApplication, ForbiddenException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import * as request from 'supertest';
import { Server } from 'node:http';
import { Prisma } from '@prisma/client';
jest.mock('jose', () => ({
  createRemoteJWKSet: jest.fn(),
  jwtVerify: jest.fn(),
}));
import { AssistantTelemetryController } from './telemetry.controller';
import { AssistantTelemetryService } from './telemetry.service';
import { PrismaService } from '../../prisma/prisma.service';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../../auth/guards/password-set.guard';
import { TenantGuard } from '../../auth/guards/tenant.guard';
import { TenantContext } from '../../auth/types/tenant-context.interface';
import { sanitizeEvent } from './telemetry.dto';

const ctx = {
  tenantId: 'token-tenant',
  branchId: 'allowed-branch',
  roleCode: 'OWNER',
} as TenantContext;
const event = {
  vertical: 'retail',
  intentId: 'sales_summary',
  outcome: 'ANSWERED',
  confidence: 'HIGH',
  level: 'READ',
};
describe('Assistant telemetry HTTP', () => {
  let app: INestApplication;
  const createMany = jest.fn<
    Promise<{ count: number }>,
    [{ data: Prisma.AssistantQueryLogCreateManyInput[] }]
  >();
  beforeEach(async () => {
    createMany.mockReset().mockResolvedValue({ count: 1 });
    const builder = Test.createTestingModule({
      controllers: [AssistantTelemetryController],
      providers: [
        AssistantTelemetryService,
        {
          provide: PrismaService,
          useValue: { assistantQueryLog: { createMany } },
        },
      ],
    });
    for (const guard of [JwtAuthGuard, PasswordSetGuard, TenantGuard]) {
      builder.overrideGuard(guard).useValue({ canActivate: () => true });
    }
    const module = await builder.compile();
    app = module.createNestApplication();
    app.use(
      (
        req: { tenantContext: TenantContext },
        _res: unknown,
        next: () => void,
      ) => {
        req.tenantContext = ctx;
        next();
      },
    );
    await app.init();
  });
  afterEach(async () => {
    await app.close();
  });
  it('ignores body identity/content and fixes WEB channel', async () => {
    await request(app.getHttpServer() as Server)
      .post('/assistant/telemetry')
      .send({
        tenantId: 'attacker',
        branchId: 'wrong',
        events: [
          {
            ...event,
            channel: 'ALEXA',
            tenantId: 'attacker',
            role: 'ROOT',
            userId: 'secret',
            text: 'secret',
          },
        ],
      })
      .expect(204);
    const row = (
      createMany.mock.calls[0][0] as { data: Record<string, unknown>[] }
    ).data[0];
    expect(row).toMatchObject({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      role: 'OWNER',
      channel: 'WEB',
    });
    expect(JSON.stringify(row)).not.toMatch(/secret|attacker|wrong/);
    expect(row).not.toHaveProperty('userId');
  });
  it('normalizes unknown intents and resolvedTo without storing free text', async () => {
    await request(app.getHttpServer() as Server)
      .post('/assistant/telemetry')
      .send({
        events: [
          {
            ...event,
            intentId: 'secret product',
            outcome: 'FALLBACK',
            resolvedTo: 'secret customer',
          },
        ],
      })
      .expect(204);
    expect(createMany).toHaveBeenCalledWith({
      data: [
        expect.objectContaining({ intentId: 'unknown', resolvedTo: 'unknown' }),
      ],
    });
  });
  it('returns 204 on failed storage and malformed/oversized batches', async () => {
    createMany.mockRejectedValue(new Error('offline'));
    await request(app.getHttpServer() as Server)
      .post('/assistant/telemetry')
      .send({ events: [event] })
      .expect(204);
    await request(app.getHttpServer() as Server)
      .post('/assistant/telemetry')
      .send({ events: Array(21).fill(event) })
      .expect(204);
    await request(app.getHttpServer() as Server)
      .post('/assistant/telemetry')
      .send({ events: 'invalid' })
      .expect(204);
    expect(createMany).toHaveBeenCalledTimes(1);
  });
  it('does not wait for storage', async () => {
    createMany.mockReturnValue(new Promise(() => undefined));
    await request(app.getHttpServer() as Server)
      .post('/assistant/telemetry')
      .send({ events: [event] })
      .expect(204);
  });
});
describe('Privacy and authorization', () => {
  it('rejects arbitrary dimension strings and projects role', () => {
    for (const field of ['vertical', 'level', 'outcome', 'confidence'])
      expect(
        sanitizeEvent({ ...event, [field]: 'private text' }, ctx, 'WEB'),
      ).toBeNull();
    expect(
      sanitizeEvent(
        { ...event, scope: 'private text' },
        { ...ctx, roleCode: 'private name' },
        'WEB',
      ),
    ).toMatchObject({ scope: null, role: 'OTHER' });
  });
  it('rejects non-admin insights before reading the table', () => {
    const service = { insights: jest.fn() };
    const controller = new AssistantTelemetryController(
      service as unknown as AssistantTelemetryService,
    );
    expect(() => controller.insights({ ...ctx, roleCode: 'CASHIER' })).toThrow(
      ForbiddenException,
    );
    expect(service.insights).not.toHaveBeenCalled();
  });
});

describe('Insights aggregation', () => {
  it('isolates a tenant and excludes resolution signals from all query metrics', async () => {
    const groupBy = jest.fn().mockResolvedValue([]);
    const count = jest.fn().mockResolvedValueOnce(4).mockResolvedValueOnce(1);
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ p95: 120.5 }])
      .mockResolvedValueOnce([{ day: '2026-09-18', count: 4, fallbacks: 1 }]);
    const service = new AssistantTelemetryService({
      assistantQueryLog: { groupBy, count },
      $queryRaw: queryRaw,
    } as unknown as PrismaService);
    const result = await service.insights(ctx);
    expect(result).toMatchObject({
      totalQueries: 4,
      fallbackRate: 25,
      p95LatencyMs: 121,
      fallbackTimeline: [
        { day: '2026-09-18', count: 4, fallbacks: 1, rate: 25 },
      ],
    });
    const calls = groupBy.mock.calls as [{ where: Record<string, unknown> }][];
    for (const [args] of calls) {
      expect(args.where.tenantId).toBe(ctx.tenantId);
      expect(args.where.at).toBeDefined();
    }
    expect(
      calls.filter(([args]) => args.where.resolvedTo === null),
    ).toHaveLength(4);
    expect(
      calls.filter(([args]) => args.where.resolvedTo !== null),
    ).toHaveLength(1);
    expect(count).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        tenantId: ctx.tenantId,
        resolvedTo: null,
      }) as unknown,
    });
    const sqlCalls = queryRaw.mock.calls as [Prisma.Sql][];
    for (const [sql] of sqlCalls) expect(sql.values).toContain(ctx.tenantId);
  });
});
