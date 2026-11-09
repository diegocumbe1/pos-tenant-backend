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
  /** Super-admin operando como soporte en este tenant (ver SupportSessionService). */
  supportSessionId?: string;
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
  /** Todas las sedes asignadas, de cualquier negocio. Para validar usa `branchesByTenant`. */
  accessibleBranches: string[];
  /**
   * Sedes asignadas agrupadas por negocio. Opcional: quien arma un actor sin
   * pasar por el JWT (Alexa, asistente, tests) no lo trae y se usa
   * `accessibleBranches` en el negocio principal.
   */
  branchesByTenant?: Record<string, string[]>;
  /** Negocios adicionales al principal (switch). Vacío o ausente para casi todos. */
  tenantMemberships?: Array<{ tenantId: string; roleId: string; roleCode: string }>;
}
