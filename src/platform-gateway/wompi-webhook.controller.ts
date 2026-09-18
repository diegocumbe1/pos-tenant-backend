import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { WompiEvent } from './event-checksum';
import { ChargesService } from './services/charges.service';

/**
 * Webhook de Wompi. PÚBLICO a propósito: Wompi no manda bearer, se autentica
 * con el checksum del evento (validado en ChargesService).
 *
 * Responde 200 SIEMPRE que el evento quedó registrado, incluso si se rechaza
 * por firma inválida: cualquier otro código le hace a Wompi reintentar durante
 * 24 h, y un evento falso no mejora por reintentarlo. Lo que pasó queda en la
 * bitácora, visible en Mensajería → Pasarela.
 */
@ApiExcludeController()
@Controller('platform/webhooks')
export class WompiWebhookController {
  constructor(private readonly charges: ChargesService) {}

  @Post('wompi')
  @HttpCode(HttpStatus.OK)
  async wompi(
    @Body() event: WompiEvent,
    @Headers('x-event-checksum') checksum?: string,
  ) {
    const result = await this.charges.handleEvent(event, checksum);
    return { received: true, outcome: result.outcome };
  }
}
