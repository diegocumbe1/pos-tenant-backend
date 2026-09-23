import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AssistantChannel } from '@prisma/client';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { PlatformAdminGuard } from '../../platform/guards/platform-admin.guard';
import { normalizePhone } from '../../platform-messaging/phone.util';
import { LynkoAgentService } from '../agent/lynko-agent.service';
import { SimulateAgentDto } from './simulate-agent.dto';
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
  constructor(
    private readonly inbound: WhatsAppInboundService,
    private readonly agent: LynkoAgentService,
  ) {}

  @Get('messaging/agent/diagnostics')
  @ApiOperation({
    summary: 'Últimos mensajes que le llegaron al agente y qué hizo con ellos',
  })
  diagnostics() {
    return this.inbound.diagnostics();
  }

  /**
   * Corre el agente como si hubiera llegado un WhatsApp, pero **sin enviar
   * nada**.
   *
   * Es la forma de probar el agente en local sin emparejar una sesión. Y eso
   * importa más de lo que parece: la sesión de WhatsApp se guarda en Storage
   * bajo una ruta que depende solo del `clientId`, así que emparejar la sesión
   * de plataforma desde local contra el MISMO Supabase pisaría el zip de
   * producción y podría tumbar el número real. Con esto no hace falta.
   *
   * Lo que prueba: identidad, negocios accesibles, permisos, intents, contexto
   * conversacional, horario y la redacción exacta de la respuesta.
   * Lo que NO prueba: la entrega por WhatsApp —LID, agrupación de ráfagas,
   * "escribiendo…"—, que es lo único que necesita una sesión de verdad.
   *
   * OJO: sí escribe el contexto conversacional de ese teléfono, igual que una
   * conversación real. Es lo que permite encadenar mensajes ("¿y ayer?"), pero
   * significa que simular con el número de alguien le mueve su conversación.
   */
  @Post('messaging/agent/simulate')
  @ApiOperation({ summary: 'Prueba el agente sin enviar ningún WhatsApp' })
  async simulate(@Body() dto: SimulateAgentDto) {
    let phone: string;
    try {
      phone = normalizePhone(dto.phone);
    } catch {
      throw new BadRequestException('Teléfono inválido');
    }
    const result = await this.agent.process({
      channel: AssistantChannel.WHATSAPP,
      externalUserId: phone,
      message: dto.message,
    });
    return {
      action: result.action,
      reply: result.reply ?? null,
      reason: result.reason ?? null,
      identity: result.context.identity ?? 'UNKNOWN',
      intent: result.context.intent,
      tenantId: result.context.tenantId,
      sent: false,
    };
  }
}
