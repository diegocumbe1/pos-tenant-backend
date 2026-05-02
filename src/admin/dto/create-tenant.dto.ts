import { IsEmail, IsIn, IsOptional, IsString, MinLength } from 'class-validator';

export class CreateTenantDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsIn(['BASIC', 'PRO', 'PREMIUM'])
  plan?: 'BASIC' | 'PRO' | 'PREMIUM';

  @IsString()
  @MinLength(2)
  defaultBranchName!: string;

  @IsEmail()
  ownerEmail!: string;

  @IsString()
  @MinLength(2)
  ownerName!: string;
}
