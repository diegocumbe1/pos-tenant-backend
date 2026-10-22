import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { CALENDAR_DAY } from '../../../shared/retail-calendar-day';

export class CreatePaymentCommitmentDto {
  @ApiProperty({
    type: [String],
    description: 'Ventas por cobrar que cubre. Todas del mismo cliente.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  saleIds!: string[];

  @ApiProperty({
    example: '2026-10-30',
    description: 'Día en que se compromete a pagar',
  })
  @Matches(CALENDAR_DAY, { message: 'La fecha debe ser AAAA-MM-DD' })
  dueOn!: string;

  @ApiPropertyOptional({
    example: 150000,
    description: 'Cuánto se compromete a pagar. Omitir = el saldo completo.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  amountCOP?: number;

  @ApiPropertyOptional({ example: 'Paga cuando le giren la quincena' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  remindByWhatsapp?: boolean;

  @ApiPropertyOptional({
    example: 1,
    default: 1,
    description: 'Con cuántos días de anticipación recordar. 0 = el mismo día.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(30)
  remindDaysBefore?: number;

  @ApiPropertyOptional({ description: 'Texto propio del recordatorio' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

export class UpdatePaymentCommitmentDto extends PartialType(
  CreatePaymentCommitmentDto,
) {}
