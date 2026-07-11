import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Datos de pago del negocio (POS al cobrar + recibo). Todo opcional.
export class BranchPaymentInfoDto {
  @IsOptional() @IsString() @MaxLength(60)
  bankName?: string;

  @IsOptional() @IsIn(['ahorros', 'corriente'])
  accountType?: 'ahorros' | 'corriente';

  @IsOptional() @IsString() @MaxLength(40)
  accountNumber?: string;

  @IsOptional() @IsString() @MaxLength(80)
  accountHolder?: string;

  @IsOptional() @IsString() @MaxLength(40)
  documentId?: string;

  @IsOptional() @IsString() @MaxLength(30)
  nequiPhone?: string;

  @IsOptional() @IsString() @MaxLength(30)
  daviplataPhone?: string;

  @IsOptional() @IsString() @MaxLength(500)
  qrImageUrl?: string;

  @IsOptional() @IsString() @MaxLength(500)
  qrImagePath?: string;

  @IsOptional() @IsString() @MaxLength(500)
  qrPdfUrl?: string;

  @IsOptional() @IsString() @MaxLength(500)
  qrPdfPath?: string;

  @IsOptional() @IsString() @MaxLength(160)
  qrPdfFileName?: string;

  @IsOptional() @IsIn(['nu', 'other'])
  qrProvider?: 'nu' | 'other';

  @IsOptional() @IsIn(['image', 'pdf'])
  qrSourceType?: 'image' | 'pdf';

  @IsOptional() @IsString() @MaxLength(280)
  transferInstructions?: string;

  @IsOptional() @IsBoolean()
  showOnReceipt?: boolean;
}

export class CreateBranchDto {
  @IsString()
  @MinLength(2)
  name!: string;

  @IsOptional()
  @IsString()
  address?: string;
}

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BranchPaymentInfoDto)
  paymentInfo?: BranchPaymentInfoDto;
}
