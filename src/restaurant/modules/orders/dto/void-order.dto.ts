import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class VoidOrderDto {
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;

  @IsOptional()
  @IsIn(['test', 'claim', 'mistake', 'staff_meal', 'other'])
  voidType?: 'test' | 'claim' | 'mistake' | 'staff_meal' | 'other';

  @IsOptional()
  @IsString()
  @MaxLength(120)
  byUserName?: string;
}
