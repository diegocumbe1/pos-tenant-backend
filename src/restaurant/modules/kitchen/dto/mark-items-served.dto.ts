import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsString, Min, ValidateNested } from 'class-validator';

export class ServedItemDto {
  @ApiProperty({ description: 'lineKey de la línea de la comanda' })
  @IsString()
  lineKey!: string;

  @ApiProperty({ description: 'Unidades ya en la mesa (0..cantidad de la línea)' })
  @IsInt()
  @Min(0)
  servedQty!: number;
}

export class MarkItemsServedDto {
  @ApiProperty({ type: [ServedItemDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ServedItemDto)
  items!: ServedItemDto[];
}
