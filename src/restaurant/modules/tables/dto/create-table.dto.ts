import { IsIn, IsInt, IsString, Min } from 'class-validator';

export class CreateTableDto {
  @IsString()
  areaId: string;

  @IsString()
  code: string;

  @IsInt()
  @Min(1)
  seats: number;

  @IsIn(['SQUARE', 'RECTANGLE', 'ROUND'])
  shape: string;
}
