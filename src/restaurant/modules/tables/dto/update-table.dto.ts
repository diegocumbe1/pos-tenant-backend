import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class UpdateTableDto {
  @IsOptional()
  @IsIn(['AVAILABLE', 'PREPARING', 'ON_TABLE', 'PAYMENT', 'RESERVED', 'CLOSED'])
  status?: string;

  @IsOptional()
  @IsString()
  waiterName?: string;

  @IsOptional()
  @IsString()
  code?: string;

  @IsOptional()
  @IsString()
  areaId?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  seats?: number;

  @IsOptional()
  @IsIn(['SQUARE', 'RECTANGLE', 'ROUND'])
  shape?: string;
}
