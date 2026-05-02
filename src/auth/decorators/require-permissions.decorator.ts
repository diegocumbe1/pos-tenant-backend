import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSIONS_KEY = 'requirePermissions';

/**
 * Exige que el usuario autenticado tenga **todos** los permisos listados.
 * ROOT bypasea siempre en PermissionsGuard.
 * Los codes siguen el patrón `resource:action` (ej. `restaurant:finance:read`).
 */
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(REQUIRE_PERMISSIONS_KEY, codes);
