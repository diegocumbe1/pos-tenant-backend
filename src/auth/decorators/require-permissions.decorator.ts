import { SetMetadata } from '@nestjs/common';

export const REQUIRE_PERMISSIONS_KEY = 'requirePermissions';

/**
 * Exige que el usuario autenticado tenga **todos** los permisos listados.
 * ROOT bypasea siempre en PermissionsGuard.
 * Los codes siguen el patrón `resource:action` (ej. `restaurant:finance:read`).
 */
export const RequirePermissions = (...codes: string[]) =>
  SetMetadata(REQUIRE_PERMISSIONS_KEY, codes);

export const REQUIRE_ANY_PERMISSION_KEY = 'requireAnyPermission';

/**
 * Exige **al menos uno** de los permisos listados.
 *
 * Para módulos compartidos entre verticales, donde el mismo endpoint se protege
 * con el permiso de cada una: el sitio público lo administra
 * `barber:settings:write` en barbería y `retail:settings:write` en tienda, y el
 * usuario solo tiene el de su vertical.
 */
export const RequireAnyPermission = (...codes: string[]) =>
  SetMetadata(REQUIRE_ANY_PERMISSION_KEY, codes);
