import {
  Controller,
  Get,
  Header,
  NotFoundException,
  Param,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { QR_CODE_REGEX } from './qr-code.util';
import { QrService } from './qr.service';

/**
 * Resolución del código escaneado. La consume `uselynko.com/q/<code>`.
 *
 * SIN GUARDS A PROPÓSITO: quien escanea un sticker no tiene sesión. A cambio,
 * la respuesta es lo más pobre posible —solo el destino—: ni tenantId, ni ids,
 * ni estado. Si el código no sirve, 404 sin explicar por qué.
 *
 * SIN CACHÉ a propósito también: el destino se cambia en caliente desde el
 * backoffice y una respuesta cacheada haría que el QR siguiera mandando al sitio
 * viejo justo cuando alguien acaba de corregirlo.
 */
@ApiTags('QR')
@Controller('public/qr')
export class QrPublicController {
  constructor(private readonly qr: QrService) {}

  @Get(':code')
  @Header('Cache-Control', 'no-store')
  @ApiOperation({ summary: 'Resolver un código de QR a su destino actual' })
  resolve(@Param('code') code: string) {
    // Corta antes de tocar la base: `/q/<basura larga>` no merece una consulta.
    if (!QR_CODE_REGEX.test(code)) {
      throw new NotFoundException({
        code: 'QR_NOT_AVAILABLE',
        message: 'Este enlace ya no se encuentra disponible.',
      });
    }
    return this.qr.resolve(code);
  }
}
