import { IsOptional, IsString } from 'class-validator';

export class ShareReceiptDto {
  @IsString()
  orderId: string;

  @IsOptional()
  @IsString()
  splitId?: string;
}
