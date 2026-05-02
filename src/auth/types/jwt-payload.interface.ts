/**
 * Payload del JWT de Supabase.
 * Emitido por `auth.users`, firmado HS256 con SUPABASE_JWT_SECRET.
 * Los claims de tenant/role viven en `app_metadata` (admin-only, no editable por el usuario).
 */
export interface SupabaseJwtPayload {
  sub: string; // auth.users.id (UUID)
  email?: string;
  aud: string; // 'authenticated'
  role?: string; // claim interno de Supabase ('authenticated') — no confundir con el rol RBAC
  app_metadata?: {
    tenantId?: string | null;
    roleId?: string;
    isRoot?: boolean;
    [k: string]: unknown;
  };
  user_metadata?: Record<string, unknown>;
  iat?: number;
  exp?: number;
}
