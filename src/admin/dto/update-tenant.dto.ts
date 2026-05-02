import { IsBoolean, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class UpdateTenantDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsIn(['BASIC', 'PRO', 'PREMIUM'])
  plan?: 'BASIC' | 'PRO' | 'PREMIUM';

  @IsOptional()
  @IsBoolean()
  deleted?: boolean;
}
