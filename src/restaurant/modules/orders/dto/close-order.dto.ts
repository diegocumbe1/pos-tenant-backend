import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

export class CloseOrderDto {
  @IsIn(['cash', 'qr', 'transfer', 'card'])
  paymentMethod: string;

  @IsInt()
  @Min(0)
  totalCOP: number;

  @IsOptional()
  @IsIn(['credit', 'debit'])
  cardType?: string;
}
