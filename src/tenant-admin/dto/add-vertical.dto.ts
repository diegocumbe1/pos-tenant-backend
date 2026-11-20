import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AddVerticalDto {
  @IsIn(['restaurant', 'barber', 'retail'])
  vertical!: string;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(120)
  businessName?: string;
}
