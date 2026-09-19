import { PermissionsCacheService } from '../auth/services/permissions-cache.service';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PrismaService } from '../prisma/prisma.service';
import { AssistantScopeService } from './assistant-scope.service';

describe('AssistantScopeService', () => {
  let service: AssistantScopeService;
  let findMany: jest.Mock;
  const admin = {
    id: 'u1',
    isPlatformAdmin: true,
    tenantId: null,
  } as AuthenticatedUser;

  const businesses = [
    { id: 't1', name: 'Bella Chic' },
    { id: 't2', name: 'DC Tech' },
    { id: 't3', name: 'Malexca' },
  ];

  beforeEach(() => {
    findMany = jest.fn().mockResolvedValue(businesses);
    service = new AssistantScopeService(
      {
        tenant: { findMany },
        branch: { findMany: jest.fn() },
      } as unknown as PrismaService,
      { getForRole: jest.fn() } as unknown as PermissionsCacheService,
    );
  });

  describe('resolveBusiness', () => {
    const resolve = (spoken?: string) => service.resolveBusiness(admin, spoken);

    it.each([
      ['Bella Chic', 'exacto'],
      ['bella chic', 'sin mayúsculas'],
      ['bellachic', 'pegado'],
      ['bellachi', 'pegado y cortado, como lo oye el Echo'],
    ])('resuelve "%s" (%s)', async (spoken) => {
      await expect(resolve(spoken)).resolves.toEqual({
        status: 'resolved',
        business: businesses[0],
      });
    });

    it('no acepta un negocio que no está autorizado', async () => {
      await expect(resolve('ferretería ajena')).resolves.toMatchObject({
        status: 'unknown',
      });
    });

    it('con varios negocios y sin nombre, repregunta', async () => {
      await expect(resolve(undefined)).resolves.toMatchObject({
        status: 'missing',
      });
    });

    it('con un solo negocio no pregunta nada', async () => {
      findMany.mockResolvedValue([businesses[0]]);
      await expect(resolve(undefined)).resolves.toEqual({
        status: 'resolved',
        business: businesses[0],
      });
    });

    it('marca ambiguo cuando el nombre calza con dos', async () => {
      findMany.mockResolvedValue([
        businesses[0],
        { id: 't9', name: 'Bella Chic Norte' },
      ]);
      await expect(resolve('bella')).resolves.toMatchObject({
        status: 'ambiguous',
      });
    });

    it('un nombre exacto le gana a uno que solo empieza igual', async () => {
      findMany.mockResolvedValue([
        businesses[0],
        { id: 't9', name: 'Bella Chic Norte' },
      ]);
      await expect(resolve('bella chic')).resolves.toEqual({
        status: 'resolved',
        business: businesses[0],
      });
    });
  });

  it('un usuario sin tenant no tiene negocios que consultar', async () => {
    const orphan = {
      id: 'u2',
      isPlatformAdmin: false,
      tenantId: null,
    } as AuthenticatedUser;
    await expect(service.accessibleBusinesses(orphan)).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});
