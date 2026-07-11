import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  ValidateNested,
} from 'class-validator';
import { PrintDocument } from '../printing.types';

/**
 * Documento entrante. Validamos los campos mínimos; el resto de bloques se
 * aceptan tal cual (el front es la fuente del builder cuando llama directo).
 */
export class CreatePrintJobDto {
  @IsObject()
  document: PrintDocument;

  @IsOptional()
  @IsString()
  printerId?: string;
}

export class FailPrintJobDto {
  @IsString()
  error: string;
}

export class CancelPrintJobDto {
  @IsOptional()
  @IsString()
  reason?: string;
}
