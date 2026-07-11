import { IsArray, IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateRoleDto {
  @IsString()
  @MinLength(2)
  code!: string;

  @IsString()
  @MinLength(2)
  name!: string;
}

export class UpdateRoleDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;
}

export class TogglePermissionDto {
  @IsString()
  permissionCode!: string;

  @IsBoolean()
  enabled!: boolean;
}

/** Un item del bulk. Toleramos tanto `permissionCode` como `code`, y string suelto. */
export interface RolePermissionItem {
  permissionCode?: string;
  code?: string;
  enabled?: boolean;
}

/**
 * Cuerpo del PATCH /tenant/roles/:id/permissions.
 * Soporta dos modos:
 *   • Bulk (recomendado): { permissions: [...] } con el set completo de permisos del rol.
 *     Cada item puede ser un string (código habilitado) o { code|permissionCode, enabled }.
 *     El backend hace replace-all con los habilitados.
 *   • Legacy: { permissionCode, enabled } para togglear un solo permiso.
 */
export class SetRolePermissionsDto {
  @IsOptional()
  @IsArray()
  permissions?: Array<string | RolePermissionItem>;

  @IsOptional()
  @IsString()
  permissionCode?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
