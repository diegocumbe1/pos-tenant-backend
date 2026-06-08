import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class CreateClaimDto {
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  description: string;

  @IsOptional()
  @IsIn(['low', 'medium', 'high'])
  severity?: string;

  @IsOptional()
  @IsString()
  byUserName?: string;
}
