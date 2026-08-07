import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from 'class-validator';

const PAYMENT_METHODS = ['cash', 'qr', 'transfer', 'card'] as const;
const CARD_TYPES = ['credit', 'debit'] as const;

export class PaymentContributionDto {
  @IsIn(PAYMENT_METHODS)
  method: string;

  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsIn(CARD_TYPES)
  cardType?: string;

  // Solo efectivo: con cuánto pagó el cliente y el vuelto entregado.
  @IsOptional()
  @IsInt()
  @Min(0)
  cashReceived?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  cashChange?: number;
}

export class PaymentItemDto {
  @IsString()
  productId: string;

  @IsString()
  name: string;

  @IsInt()
  @Min(1)
  qty: number;

  @IsInt()
  @Min(0)
  priceCOP: number;
}

export class RegisterPaymentDto {
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentContributionDto)
  contributions: PaymentContributionDto[];

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => PaymentItemDto)
  items: PaymentItemDto[];

  @IsInt()
  @Min(0)
  totalCOP: number;
}
