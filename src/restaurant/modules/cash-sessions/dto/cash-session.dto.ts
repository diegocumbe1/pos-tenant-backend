import { IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';
import { CashMovementType } from '@prisma/client';

const METHODS = ['cash', 'card', 'transfer', 'qr'];
const MOVEMENT_TYPES = Object.values(CashMovementType);

export class OpenCashSessionDto {
  @IsString()
  terminalId: string;

  @IsInt()
  @Min(0)
  openingAmount: number;

  @IsOptional()
  @IsString()
  openingNote?: string;
}

export class CloseCashSessionDto {
  @IsInt()
  @Min(0)
  countedAmount: number;

  @IsOptional()
  @IsString()
  closingNote?: string;
}

export class CreateCashMovementDto {
  @IsIn(MOVEMENT_TYPES)
  type: CashMovementType;

  @IsIn(METHODS)
  method: string;

  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsString()
  reference?: string;

  @IsOptional()
  @IsString()
  note?: string;
}
