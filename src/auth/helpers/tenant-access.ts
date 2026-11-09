import type { AuthenticatedUser } from '../types/tenant-context.interface';

/** Con qué rol y en qué sedes opera una persona dentro de un negocio. */
export type TenantAccess = {
  tenantId: string;
  roleId: string;
  roleCode: string;
  /** true = el negocio de `User.tenantId`; false = acceso adicional (switch). */
  isPrimary: boolean;
  accessibleBranches: string[];
};

/**
 * Regla única de "¿esta persona puede operar este negocio?".
 *
 * El negocio principal sale de `User.tenantId`/`User.roleId`; los demás, de
 * `user_tenant_memberships`. Las sedes se filtran por el negocio pedido para
 * que una sede de un negocio nunca valide contra el otro.
 *
 * No cubre ROOT ni el modo soporte: esos se resuelven antes, en cada guard.
 */
export function resolveTenantAccess(
  user: Pick<
    AuthenticatedUser,
    | 'tenantId'
    | 'roleId'
    | 'roleCode'
    | 'accessibleBranches'
    | 'tenantMemberships'
    | 'branchesByTenant'
  >,
  tenantId: string | null | undefined,
): TenantAccess | null {
  if (!tenantId) return null;
  // Sin el mapa (actor armado fuera del JWT) se conserva el comportamiento de
  // antes: todas sus sedes, que son las de su único negocio.
  const branches = user.branchesByTenant
    ? (user.branchesByTenant[tenantId] ?? [])
    : user.tenantId === tenantId
      ? user.accessibleBranches
      : [];

  if (user.tenantId === tenantId) {
    return {
      tenantId,
      roleId: user.roleId,
      roleCode: user.roleCode,
      isPrimary: true,
      accessibleBranches: branches,
    };
  }

  const membership = user.tenantMemberships?.find(
    (m) => m.tenantId === tenantId,
  );
  if (!membership) return null;
  return {
    tenantId,
    roleId: membership.roleId,
    roleCode: membership.roleCode,
    isPrimary: false,
    accessibleBranches: branches,
  };
}

/** Agrupa las sedes asignadas por negocio. */
export function groupBranchesByTenant(
  userBranches: Array<{ branchId: string; branch: { tenantId: string } }>,
): Record<string, string[]> {
  const grouped: Record<string, string[]> = {};
  for (const ub of userBranches) {
    (grouped[ub.branch.tenantId] ??= []).push(ub.branchId);
  }
  return grouped;
}

/** Include de Prisma con lo que necesitan `AuthenticatedUser` y `resolveTenantAccess`. */
export const AUTH_USER_INCLUDE = {
  role: true,
  userBranches: {
    select: { branchId: true, branch: { select: { tenantId: true } } },
  },
  tenantMemberships: {
    where: { isActive: true, tenant: { deletedAt: null } },
    select: { tenantId: true, roleId: true, role: { select: { code: true } } },
  },
} as const;

type AuthUserRow = {
  id: string;
  email: string;
  name: string;
  tenantId: string | null;
  roleId: string;
  isPlatformAdmin: boolean;
  passwordSetAt: Date | null;
  role: { code: string };
  userBranches: Array<{ branchId: string; branch: { tenantId: string } }>;
  tenantMemberships: Array<{
    tenantId: string;
    roleId: string;
    role: { code: string };
  }>;
};

/** Fila de Prisma (con `AUTH_USER_INCLUDE`) → `AuthenticatedUser`. */
export function toAuthenticatedUser(user: AuthUserRow): AuthenticatedUser {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    tenantId: user.tenantId,
    roleId: user.roleId,
    roleCode: user.role.code,
    isRoot: user.role.code === 'ROOT',
    isPlatformAdmin: user.isPlatformAdmin || user.role.code === 'ROOT',
    passwordSetAt: user.passwordSetAt,
    accessibleBranches: user.userBranches.map((ub) => ub.branchId),
    branchesByTenant: groupBranchesByTenant(user.userBranches),
    tenantMemberships: user.tenantMemberships.map((m) => ({
      tenantId: m.tenantId,
      roleId: m.roleId,
      roleCode: m.role.code,
    })),
  };
}
