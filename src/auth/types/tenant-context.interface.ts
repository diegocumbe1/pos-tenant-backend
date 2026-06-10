/**
 * Contexto resuelto por TenantGuard a partir del JWT + headers X-Tenant-Id/X-Branch-Id.
 * Inyectado en controllers vía `@CurrentTenant()`.
 */
export interface TenantContext {
  userId: string;
  email: string;
  name: string;
  tenantId: string; // para ROOT cuando actúa en nombre de un tenant, aquí va el tenant operativo
  branchId: string; // branch seleccionado por header (debe estar en accessibleBranches, o user es ROOT)
  roleId: string;
  roleCode: string; // 'ROOT' | 'OWNER' | ... | custom
  isRoot: boolean;
  permissions: Set<string>;
  accessibleBranches: string[]; // branches a las que el user pertenece (o [] para ROOT)
}

/** Shape adjuntado a `req.user` por JwtStrategy (pre-TenantGuard). */
export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  tenantId: string | null;
  roleId: string;
  roleCode: string;
  isRoot: boolean;
  /** Identidad de plataforma (super-admin). El ROOT siempre cuenta como tal. */
  isPlatformAdmin: boolean;
  passwordSetAt: Date | null;
  accessibleBranches: string[];
}
