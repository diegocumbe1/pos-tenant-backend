import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

// Billetera o llave que el negocio agrega a mano (Movii, Dale!, Bancolombia a
// la mano…). Genérico a propósito: en Colombia sale un medio nuevo cada año y
// no queremos migrar el modelo por cada uno.
export class BranchWalletDto {
  @IsString() @MaxLength(40)
  id!: string;

  @IsString() @MaxLength(40)
  label!: string;

  @IsString() @MaxLength(80)
  reference!: string;

  @IsOptional() @IsString() @MaxLength(160)
  instructions?: string;
}

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

  // Llave Bre-B tal como el negocio la registró en su banco (@negocio, #cedula,
  // celular o correo). Se guarda con su símbolo: el cliente la pega igual.
  @IsOptional() @IsString() @MaxLength(60)
  brebKey?: string;

  @IsOptional() @IsIn(['alfanumerica', 'celular', 'documento', 'correo'])
  brebKeyType?: 'alfanumerica' | 'celular' | 'documento' | 'correo';

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @ValidateNested({ each: true })
  @Type(() => BranchWalletDto)
  wallets?: BranchWalletDto[];

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
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}

export class UpdateBranchDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  address?: string;

  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => BranchPaymentInfoDto)
  paymentInfo?: BranchPaymentInfoDto;
}
