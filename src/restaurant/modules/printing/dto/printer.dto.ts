import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PrinterConnection, PrinterTarget } from '@prisma/client';

const TARGETS = Object.values(PrinterTarget);
const CONNECTIONS = Object.values(PrinterConnection);

export class CreatePrinterDto {
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name: string;

  @IsIn(TARGETS)
  target: PrinterTarget;

  @IsIn(CONNECTIONS)
  connection: PrinterConnection;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsIn([58, 80])
  paperWidth?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

export class UpdatePrinterDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @IsOptional()
  @IsIn(TARGETS)
  target?: PrinterTarget;

  @IsOptional()
  @IsIn(CONNECTIONS)
  connection?: PrinterConnection;

  @IsOptional()
  @IsString()
  address?: string;

  @IsOptional()
  @IsIn([58, 80])
  paperWidth?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
