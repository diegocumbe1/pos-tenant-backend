import {
  IsBoolean,
  IsIn,
  IsInt,
  IsIP,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
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
  @IsIP()
  ipAddress?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsIn([58, 80])
  paperWidth?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** El agente local reporta si alcanzó la impresora por TCP. */
export class PrinterHeartbeatDto {
  @IsBoolean()
  online: boolean;
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
  @IsIP()
  ipAddress?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @IsOptional()
  @IsIn([58, 80])
  paperWidth?: number;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
