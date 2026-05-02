import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

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
