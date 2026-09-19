import { IsBoolean, IsObject, IsOptional, IsString } from 'class-validator';

export class ShareReceiptDto {
  @IsString()
  orderId: string;

  @IsOptional()
  @IsString()
  splitId?: string;

  @IsOptional()
  @IsObject()
  payload?: Record<string, unknown>;

  /**
   * Actualizar el recibo YA COMPARTIDO, sin crear uno nuevo.
   *
   * El payload es una foto del documento tomada al compartirlo: si después la
   * venta se cobra o se entrega, el enlace que el cliente guardó sigue
   * mostrando el estado viejo. Quien cambie la venta vuelve a mandar el
   * payload con esta bandera y el enlace queda al día, con el mismo token.
   *
   * Sin la bandera, ese mismo llamado acuñaría un enlace público para una
   * venta que nadie compartió — un token de más por cada venta que se toca.
   */
  @IsOptional()
  @IsBoolean()
  refreshOnly?: boolean;
}
