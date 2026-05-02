import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  MaxLength,
  Min,
} from 'class-validator';

export const OCCASIONS = [
  'birthday',
  'anniversary',
  'business',
  'graduation',
  'other',
] as const;
export type Occasion = (typeof OCCASIONS)[number];

export class CreateReservationDto {
  @ApiProperty()
  @IsString()
  tableId!: string;

  @ApiProperty({ description: 'Timestamp ms' })
  @IsInt()
  @IsPositive()
  scheduledAt!: number;

  @ApiPropertyOptional({ description: 'Timestamp ms' })
  @IsOptional()
  @IsInt()
  @IsPositive()
  scheduledEnd?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  guestName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  guestPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(1)
  partySize?: number;

  @ApiPropertyOptional({ enum: OCCASIONS })
  @IsOptional()
  @IsIn(OCCASIONS as unknown as string[])
  occasion?: Occasion;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(255)
  occasionNote?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
