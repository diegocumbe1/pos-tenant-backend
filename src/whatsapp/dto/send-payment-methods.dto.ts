import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

// Enviar los medios de pago del negocio a un cliente.
//
// `body` llega cuando el cajero revisó (y quizá editó) el texto en el POS: se
// respeta tal cual. Sin `body`, el backend lo arma con el paymentInfo de la sede
// — así un cobro automático manda exactamente el mismo mensaje.
export class SendPaymentMethodsDto {
  @IsString()
  @MinLength(7)
  @MaxLength(20)
  to!: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  amountCOP?: number;

  @IsOptional()
  @IsString()
  @MaxLength(60)
  reference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(300)
  note?: string;
}
