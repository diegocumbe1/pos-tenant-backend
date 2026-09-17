import { IsBoolean, IsOptional, IsString, MinLength } from 'class-validator';

/**
 * Se puede mandar solo el texto, solo el interruptor, o ambos. El tope de
 * caracteres lo valida el servicio, porque depende de la plantilla.
 */
export class UpdateWhatsappTemplateDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  body?: string;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
