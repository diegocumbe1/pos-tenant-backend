import { BadRequestException, NotFoundException } from '@nestjs/common';
import { QrCode, QrCodeType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QrService } from './qr.service';

/**
 * Prisma de mentira, en memoria, con lo justo que toca este servicio.
 *
 * Se usa un doble y no la base real porque lo que hay que probar acá es la
 * REGLA (el código no cambia salvo revocación), no el SQL.
 */
function makePrisma() {
  const rows: QrCode[] = [];
  const audits: Array<{ action: string; targetId: string; after: unknown }> = [];
  let seq = 0;

  const qrCode = {
    rows,
    findUnique: jest.fn(
      ({ where }: { where: Record<string, unknown> }): Promise<QrCode | null> => {
        if (typeof where.code === 'string') {
          return Promise.resolve(rows.find((r) => r.code === where.code) ?? null);
        }
        if (typeof where.id === 'string') {
          return Promise.resolve(rows.find((r) => r.id === where.id) ?? null);
        }
        const key = where.scopeId_type as { scopeId: string; type: QrCodeType };
        return Promise.resolve(
          rows.find((r) => r.scopeId === key.scopeId && r.type === key.type) ??
            null,
        );
      },
    ),
    create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
      seq += 1;
      const row: QrCode = {
        id: `qr-${seq}`,
        code: data.code as string,
        type: (data.type as QrCodeType) ?? QrCodeType.BUSINESS_CARD,
        scopeId: data.scopeId as string,
        tenantId: (data.tenantId as string | null) ?? null,
        branchId: (data.branchId as string | null) ?? null,
        targetUrl: (data.targetUrl as string | null) ?? null,
        active: true,
        cardTitle: null,
        cardSubtitle: null,
        cardCta: null,
        createdAt: new Date('2026-09-19T12:00:00Z'),
        updatedAt: new Date('2026-09-19T12:00:00Z'),
      };
      rows.push(row);
      return Promise.resolve(row);
    }),
    update: jest.fn(
      ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const row = rows.find((r) => r.id === where.id);
        if (!row) throw new Error('not found');
        Object.assign(row, data, { updatedAt: new Date() });
        return Promise.resolve(row);
      },
    ),
  };

  const prisma = {
    qrCode,
    tenant: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) =>
        Promise.resolve(
          where.id === 'tenant-bella' ? { name: 'Bella Chic' } : null,
        ),
      ),
    },
    publicSite: {
      findMany: jest.fn(() =>
        Promise.resolve([
          { slug: 'bella-chic', publishedSlug: 'bella-chic', status: 'published' },
        ]),
      ),
      findFirst: jest.fn(() =>
        Promise.resolve({
          shortName: 'Bella Chic',
          city: 'Florencia',
          seoDescription: 'Belleza y cuidado personal',
          themeLogoUrl: 'https://cdn.test/logo.png',
          themePrimary: '#d81159',
          themeAccent: '#ffb6c9',
          status: 'published',
          updatedAt: new Date(),
        }),
      ),
    },
    menuPublicConfig: { findUnique: jest.fn(() => Promise.resolve(null)) },
    branch: {
      findUnique: jest.fn(({ where }: { where: { id: string } }) => {
        if (where.id === 'branch-centro') {
          return Promise.resolve({
            name: 'Sede Centro',
            tenantId: 'tenant-bella',
            tenant: { name: 'Bella Chic' },
            paymentInfo: {
              brebKey: '@bellachic',
              accountHolder: 'Paola Gómez',
              // Personal: NO puede salir en la página pública.
              documentId: '1077877963',
            },
          });
        }
        if (where.id === 'branch-sin-datos') {
          return Promise.resolve({
            name: 'Sede Nueva',
            tenantId: 'tenant-bella',
            tenant: { name: 'Bella Chic' },
            paymentInfo: null,
          });
        }
        if (where.id === 'branch-ajena') {
          return Promise.resolve({
            name: 'Sede de otro',
            tenantId: 'tenant-otro',
            tenant: { name: 'Otro Negocio' },
            paymentInfo: { brebKey: '@otro' },
          });
        }
        return Promise.resolve(null);
      }),
    },
    platformAuditLog: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        audits.push({
          action: data.action as string,
          targetId: data.targetId as string,
          after: data.after,
        });
        return Promise.resolve({});
      }),
    },
  };

  return { prisma, rows, audits };
}

describe('QrService', () => {
  const ACTOR = 'user-root';
  let service: QrService;
  let db: ReturnType<typeof makePrisma>;

  beforeEach(() => {
    process.env.PUBLIC_APP_URL = 'https://uselynko.com';
    db = makePrisma();
    service = new QrService(db.prisma as unknown as PrismaService);
  });

  it('crea el QR de un tenant que no tiene, con el sitio publicado como destino', async () => {
    const qr = await service.createForTenant('tenant-bella', {}, ACTOR);

    expect(qr.code).toMatch(/^bc-/);
    expect(qr.targetUrl).toBe('/sites/bella-chic');
    expect(qr.scanUrl).toBe(`https://uselynko.com/q/${qr.code}`);
    expect(qr.resolvedTargetUrl).toBe('https://uselynko.com/sites/bella-chic');
    expect(qr.active).toBe(true);
    expect(db.audits.map((a) => a.action)).toEqual(['tenant.qr.created']);
  });

  it('no duplica: pedir otro QR devuelve el MISMO código', async () => {
    const first = await service.createForTenant('tenant-bella', {}, ACTOR);
    const second = await service.createForTenant('tenant-bella', {}, ACTOR);

    expect(second.code).toBe(first.code);
    expect(second.id).toBe(first.id);
    expect(db.rows).toHaveLength(1);
    // Y no se audita un alta que no ocurrió.
    expect(db.audits).toHaveLength(1);
  });

  it('resuelve el código escaneado a su destino absoluto', async () => {
    const qr = await service.createForTenant('tenant-bella', {}, ACTOR);

    await expect(service.resolve(qr.code)).resolves.toEqual({
      kind: 'redirect',
      targetUrl: 'https://uselynko.com/sites/bella-chic',
    });
  });

  it('cambiar el destino NO cambia el código impreso', async () => {
    const qr = await service.createForTenant('tenant-bella', {}, ACTOR);

    const updated = await service.updateForTenant(
      'tenant-bella',
      { targetUrl: '/c/bella-chic' },
      ACTOR,
    );

    expect(updated.code).toBe(qr.code);
    await expect(service.resolve(qr.code)).resolves.toEqual({
      kind: 'redirect',
      targetUrl: 'https://uselynko.com/c/bella-chic',
    });
    expect(db.audits.map((a) => a.action)).toContain('tenant.qr.target_updated');
  });

  it('rechaza un destino que no sea ruta interna ni http(s)', async () => {
    await service.createForTenant('tenant-bella', {}, ACTOR);

    await expect(
      service.updateForTenant(
        'tenant-bella',
        { targetUrl: 'javascript:alert(1)' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('desactivar deja de redirigir', async () => {
    const qr = await service.createForTenant('tenant-bella', {}, ACTOR);
    await service.updateForTenant('tenant-bella', { active: false }, ACTOR);

    await expect(service.resolve(qr.code)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(db.audits.map((a) => a.action)).toContain('tenant.qr.disabled');
  });

  it('un código inexistente responde 404 sin contar nada', async () => {
    await expect(service.resolve('bc-noexiste')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('revocar mata el código anterior y entrega uno nuevo', async () => {
    const qr = await service.createForTenant('tenant-bella', {}, ACTOR);

    const rotated = await service.revokeForTenant(
      'tenant-bella',
      'Se filtró el arte impreso',
      ACTOR,
    );

    expect(rotated.code).not.toBe(qr.code);
    // Lo impreso con el código viejo deja de funcionar: eso es el punto.
    await expect(service.resolve(qr.code)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    await expect(service.resolve(rotated.code)).resolves.toEqual({
      kind: 'redirect',
      targetUrl: 'https://uselynko.com/sites/bella-chic',
    });
    expect(db.audits.map((a) => a.action)).toContain('tenant.qr.revoked');
  });

  it('un tenant inexistente no crea nada', async () => {
    await expect(
      service.createForTenant('tenant-fantasma', {}, ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(db.rows).toHaveLength(0);
  });

  it('el panel expone la marca del sitio público sin duplicarla', async () => {
    const panel = await service.getForTenant('tenant-bella');

    expect(panel.qr).toBeNull();
    expect(panel.suggestedTargetUrl).toBe('/sites/bella-chic');
    expect(panel.branding).toMatchObject({
      businessName: 'Bella Chic',
      logoUrl: 'https://cdn.test/logo.png',
      primaryColor: '#d81159',
    });
  });

  // ─── Escarapela de cobro ────────────────────────────────────────────────────

  it('la escarapela es de la SEDE: dos sedes, dos códigos distintos', async () => {
    const centro = await service.createForBranch(
      'tenant-bella',
      'branch-centro',
      ACTOR,
    );

    expect(centro.branchId).toBe('branch-centro');
    expect(centro.type).toBe(QrCodeType.PAYMENT);
    // No redirige a ningún lado: la página la pinta Lynko.
    expect(centro.targetUrl).toBeNull();
    expect(centro.resolvedTargetUrl).toBeNull();
    expect(centro.scanUrl).toBe(`https://uselynko.com/q/${centro.code}`);
  });

  it('escanear la escarapela devuelve los datos de cobro, sin la cédula', async () => {
    const qr = await service.createForBranch(
      'tenant-bella',
      'branch-centro',
      ACTOR,
    );

    const resolved = await service.resolve(qr.code);

    expect(resolved.kind).toBe('payment');
    if (resolved.kind !== 'payment') throw new Error('unreachable');
    expect(resolved.payment.branchName).toBe('Sede Centro');
    expect(resolved.payment.paymentInfo).toEqual({
      brebKey: '@bellachic',
      accountHolder: 'Paola Gómez',
    });
    // La cédula del titular NO se publica en una URL abierta.
    expect(resolved.payment.paymentInfo).not.toHaveProperty('documentId');
  });

  it('sin medios de pago cargados no deja generar la escarapela', async () => {
    // Un QR que lleva a una página vacía es peor que no tener QR: el cliente
    // lo descubre con el celular en la mano frente a la caja.
    await expect(
      service.createForBranch('tenant-bella', 'branch-sin-datos', ACTOR),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(db.rows).toHaveLength(0);
  });

  it('no se puede tocar la escarapela de una sede de otro negocio', async () => {
    await expect(
      service.createForBranch('tenant-bella', 'branch-ajena', ACTOR),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('la escarapela no acepta destino', async () => {
    await service.createForBranch('tenant-bella', 'branch-centro', ACTOR);

    await expect(
      service.updateForBranch(
        'tenant-bella',
        'branch-centro',
        { targetUrl: '/otra-cosa' },
        ACTOR,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('desactivar la escarapela deja de mostrar los datos de cobro', async () => {
    const qr = await service.createForBranch(
      'tenant-bella',
      'branch-centro',
      ACTOR,
    );
    await service.updateForBranch(
      'tenant-bella',
      'branch-centro',
      { active: false },
      ACTOR,
    );

    await expect(service.resolve(qr.code)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('el QR de la landing vive en la misma tabla, sin tenant', async () => {
    const qr = await service.createPlatform({ targetUrl: '/' }, ACTOR);

    expect(qr.tenantId).toBeNull();
    expect(qr.type).toBe(QrCodeType.PLATFORM);
    await expect(service.resolve(qr.code)).resolves.toEqual({
      kind: 'redirect',
      targetUrl: 'https://uselynko.com/',
    });

    const again = await service.createPlatform({}, ACTOR);
    expect(again.code).toBe(qr.code);
  });
});
