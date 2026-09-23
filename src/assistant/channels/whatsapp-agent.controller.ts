import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../platform/guards/platform-admin.guard';
import { WhatsAppInboundService } from './whatsapp-inbound.service';

/**
 * Diagnóstico del agente, para la consola del super-admin.
 *
 * Existe porque el modo de fallo del agente es el SILENCIO: un mensaje que no
 * se responde se ve igual que un mensaje que nunca llegó, y desde el backoffice
 * no había forma de distinguir "no me está llegando nada" de "me llega y lo
 * estoy descartando". Esto lo dice.
 *
 * Mismos guards que el resto de `/platform/*`: super-admin y nada más. No
 * devuelve el texto de ningún mensaje.
 */
@ApiTags('Platform Messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class WhatsAppAgentController {
  constructor(private readonly inbound: WhatsAppInboundService) {}

  @Get('messaging/agent/diagnostics')
  @ApiOperation({
    summary: 'Últimos mensajes que le llegaron al agente y qué hizo con ellos',
  })
  diagnostics() {
    return this.inbound.diagnostics();
  }
}
