import { resolveTenantAccess } from './tenant-access';

describe('resolveTenantAccess', () => {
  const singleBusiness = {
    tenantId: 'rest',
    roleId: 'role-owner-rest',
    roleCode: 'OWNER',
    accessibleBranches: ['b-rest'],
    branchesByTenant: { rest: ['b-rest'] },
    tenantMemberships: [],
  };

  const twoBusinesses = {
    ...singleBusiness,
    accessibleBranches: ['b-rest', 'b-agenda'],
    branchesByTenant: { rest: ['b-rest'], agenda: ['b-agenda'] },
    tenantMemberships: [
      {
        tenantId: 'agenda',
        roleId: 'role-manager-agenda',
        roleCode: 'MANAGER',
      },
    ],
  };

  it('con un solo negocio, entra al suyo con su rol y sus sedes, como antes', () => {
    expect(resolveTenantAccess(singleBusiness, 'rest')).toEqual({
      tenantId: 'rest',
      roleId: 'role-owner-rest',
      roleCode: 'OWNER',
      isPrimary: true,
      accessibleBranches: ['b-rest'],
    });
  });

  it('con un solo negocio, cualquier otro negocio sigue rechazado', () => {
    expect(resolveTenantAccess(singleBusiness, 'agenda')).toBeNull();
  });

  it('en el negocio adicional usa el rol de ESE negocio', () => {
    const access = resolveTenantAccess(twoBusinesses, 'agenda');
    expect(access?.roleId).toBe('role-manager-agenda');
    expect(access?.roleCode).toBe('MANAGER');
    expect(access?.isPrimary).toBe(false);
  });

  it('las sedes de un negocio no valen en el otro', () => {
    expect(
      resolveTenantAccess(twoBusinesses, 'rest')?.accessibleBranches,
    ).toEqual(['b-rest']);
    expect(
      resolveTenantAccess(twoBusinesses, 'agenda')?.accessibleBranches,
    ).toEqual(['b-agenda']);
  });

  it('sin el mapa por negocio (actor armado fuera del JWT) conserva todas sus sedes en el principal', () => {
    const legacyActor = {
      tenantId: 'rest',
      roleId: 'r',
      roleCode: 'OWNER',
      accessibleBranches: ['b1', 'b2'],
    };
    expect(
      resolveTenantAccess(legacyActor, 'rest')?.accessibleBranches,
    ).toEqual(['b1', 'b2']);
    expect(resolveTenantAccess(legacyActor, 'otro')).toBeNull();
  });

  it('sin negocio pedido no hay acceso', () => {
    expect(resolveTenantAccess(singleBusiness, undefined)).toBeNull();
  });
});
