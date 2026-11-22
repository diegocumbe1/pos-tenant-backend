import { Controller, Get, Header, Param } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { ChargesService } from './services/charges.service';

/**
 * Ticket de cobro público: `/cobro/<token>` en la web.
 *
 * Sin auth a propósito: el cliente lo abre desde WhatsApp. La única llave es el
 * token (aleatorio, 144 bits). Un token inexistente o malformado responde 404
 * igual, sin pistas. `no-store`: el estado cambia al pagar y no debe quedarse
 * en ninguna caché.
 */
@ApiTags('PublicCharges')
@Controller('public/charges')
export class PublicChargesController {
  constructor(private readonly charges: ChargesService) {}

  @Get(':token')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Ticket de cobro por token (público)' })
  get(@Param('token') token: string) {
    return this.charges.getPublicView(token);
  }
}
