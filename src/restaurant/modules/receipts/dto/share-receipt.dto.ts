import { IsObject, IsOptional, IsString } from 'class-validator';

export class ShareReceiptDto {
  @IsString()
  orderId: string;

  @IsOptional()
  @IsString()
  splitId?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;
}
