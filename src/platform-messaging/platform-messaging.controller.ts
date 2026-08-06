import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Sse,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { OnEvent } from '@nestjs/event-emitter';
import {
  ApiBearerAuth,
  ApiBody,
  ApiConsumes,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { PlatformMessageChannel } from '@prisma/client';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformActor } from '../platform/decorators/platform-actor.decorator';
import { PlatformAdminGuard } from '../platform/guards/platform-admin.guard';
import {
  ImageUploadService,
  UploadedImageFile,
} from '../assets/image-upload.service';
import { WhatsAppSessionManager } from '../whatsapp/whatsapp-session.manager';
import {
  PreviewMessageDto,
  SendMessageDto,
  SendTestEmailDto,
  UpdateMessagingSettingsDto,
  UpdateTemplateDto,
  UpsertPaymentMethodDto,
} from './dto/platform-messaging.dto';
import {
  PLATFORM_BRANCH_ID,
  PLATFORM_TENANT_ID,
} from './platform-messaging.constants';
import { MessageSenderService } from './services/message-sender.service';
import { MessagingSettingsService } from './services/messaging-settings.service';
import { PaymentMethodsService } from './services/payment-methods.service';
import { TemplatesService } from './services/templates.service';
import { TEMPLATE_VARIABLES } from './template-variables';
import { EmailPlatformChannel } from './channels/email.channel';

interface WaStatusEvent {
  tenantId: string;
  branchId: string;
  status: string;
  qr?: string;
  phoneNumber?: string;
  error?: string;
}

/** Ancho de salida del QR: por debajo de ~600 px la cámara sufre para leerlo. */
const QR_MAX_WIDTH = 800;

/**
 * Mensajería de plataforma (super-admin → dueño del tenant).
 * Guards: JwtAuthGuard → PlatformAdminGuard. NO usa TenantGuard ni X-Tenant-Id.
 * Todo envío es MANUAL: no hay scheduler. Ver docs/PLATFORM_MESSAGING_PLAN.md.
 */
@ApiTags('Platform Messaging')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, PlatformAdminGuard)
@Controller('platform')
export class PlatformMessagingController {
  private readonly waStatus$ = new Subject<WaStatusEvent>();

  constructor(
    private readonly templates: TemplatesService,
    private readonly paymentMethods: PaymentMethodsService,
    private readonly settings: MessagingSettingsService,
    private readonly sender: MessageSenderService,
    private readonly sessions: WhatsAppSessionManager,
    private readonly images: ImageUploadService,
    private readonly email: EmailPlatformChannel,
  ) {}

  @OnEvent('wa.status')
  onWaStatus(payload: WaStatusEvent) {
    this.waStatus$.next(payload);
  }

  // ─── Canales ────────────────────────────────────────────────────────────────

  @Get('messaging/channels')
  @ApiOperation({ summary: 'Estado de WhatsApp y correo de la plataforma' })
  channels() {
    return this.sender.channelStatus();
  }

  @Post('messaging/channels/whatsapp/pair')
  @HttpCode(HttpStatus.ACCEPTED)
  @ApiOperation({ summary: 'Inicia el pareo del WhatsApp de Lynko (devuelve QR por SSE)' })
  pairWhatsApp() {
    return this.sessions.pair(PLATFORM_TENANT_ID, PLATFORM_BRANCH_ID);
  }

  @Sse('messaging/channels/whatsapp/stream')
  streamWhatsApp(): Observable<MessageEvent> {
    const initial = this.sessions.getStatus(PLATFORM_TENANT_ID, PLATFORM_BRANCH_ID);
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({
        data: { ...initial, tenantId: PLATFORM_TENANT_ID },
      } as MessageEvent);
      // Latido: mantiene viva la conexión detrás de proxies que cortan por inactividad.
      const heartbeat = setInterval(() => {
        subscriber.next({
          data: this.sessions.getStatus(PLATFORM_TENANT_ID, PLATFORM_BRANCH_ID),
        } as MessageEvent);
      }, 25000);
      const sub = this.waStatus$
        .pipe(
          filter((e) => e.tenantId === PLATFORM_TENANT_ID),
          map((e) => ({ data: e }) as MessageEvent),
        )
        .subscribe((msg) => subscriber.next(msg));
      return () => {
        clearInterval(heartbeat);
        sub.unsubscribe();
      };
    });
  }

  @Delete('messaging/channels/whatsapp')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnectWhatsApp() {
    return this.sessions.disconnect(PLATFORM_TENANT_ID, PLATFORM_BRANCH_ID);
  }

  @Post('messaging/channels/email/test')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Envía un correo de prueba con la configuración actual' })
  async testEmail(@Body() dto: SendTestEmailDto) {
    const sent = await this.email.send({
      to: dto.to,
      subject: 'Prueba de correo · Lynko',
      body: 'Este es un correo de prueba de la consola de plataforma. Si lo recibes, el canal está bien configurado.',
      html: '<p>Este es un correo de prueba de la consola de plataforma.</p><p>Si lo recibes, el canal está bien configurado.</p>',
    });
    return { ok: true, id: sent.id };
  }

  // ─── Plantillas ─────────────────────────────────────────────────────────────

  @Get('messaging/templates')
  @ApiQuery({ name: 'channel', required: false, enum: PlatformMessageChannel })
  listTemplates(@Query('channel') channel?: PlatformMessageChannel) {
    return this.templates.list(channel);
  }

  @Patch('messaging/templates/:id')
  updateTemplate(@Param('id') id: string, @Body() dto: UpdateTemplateDto) {
    return this.templates.update(id, dto);
  }

  @Post('messaging/templates/:id/restore')
  @HttpCode(HttpStatus.OK)
  restoreTemplate(@Param('id') id: string) {
    return this.templates.restore(id);
  }

  @Get('messaging/variables')
  variables() {
    return TEMPLATE_VARIABLES;
  }

  // ─── Medios de pago ─────────────────────────────────────────────────────────

  @Get('messaging/payment-methods')
  listPaymentMethods() {
    return this.paymentMethods.list();
  }

  @Post('messaging/payment-methods')
  createPaymentMethod(@Body() dto: UpsertPaymentMethodDto) {
    return this.paymentMethods.create(dto);
  }

  @Patch('messaging/payment-methods/:id')
  updatePaymentMethod(
    @Param('id') id: string,
    @Body() dto: Partial<UpsertPaymentMethodDto>,
  ) {
    return this.paymentMethods.update(id, dto);
  }

  @Delete('messaging/payment-methods/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  deletePaymentMethod(@Param('id') id: string) {
    return this.paymentMethods.remove(id);
  }

  /**
   * Subida del QR. No se reusa `POST /assets/upload` porque ese exige
   * X-Tenant-Id (TenantGuard) y el backoffice no tiene tenant activo; el
   * servicio de imágenes sí se reutiliza tal cual.
   */
  @Post('messaging/payment-methods/qr')
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' } },
    },
  })
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 5_242_880 } }))
  async uploadQr(@UploadedFile() file: UploadedImageFile) {
    const isPdf = file?.mimetype === 'application/pdf';
    const result = isPdf
      ? await this.images.uploadPdf({ file, pathPrefix: 'platform/payment-qr' })
      : await this.images.uploadImage({
          file,
          // 'thumbnail' es el kind con el mínimo de dimensiones más bajo: un QR
          // recortado suele ser cuadrado y chico, y con 'default' (480×320) se
          // rechazaría por ancho.
          kind: 'thumbnail',
          maxWidth: QR_MAX_WIDTH,
          pathPrefix: 'platform/payment-qr',
        });
    return { url: result.publicUrl, isPdf, path: result.path };
  }

  // ─── Envío manual sobre un tenant ───────────────────────────────────────────

  @Post('tenants/:id/messages/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Renderiza el mensaje con los datos reales de la cuenta' })
  preview(@Param('id') tenantId: string, @Body() dto: PreviewMessageDto) {
    return this.sender.preview(tenantId, dto.templateKey, dto.channels, {
      includeQr: true,
    });
  }

  @Post('tenants/:id/messages/send')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Envía por los canales pedidos; tolerante por canal' })
  send(
    @Param('id') tenantId: string,
    @Body() dto: SendMessageDto,
    @PlatformActor() actor: AuthenticatedUser,
  ) {
    return this.sender.send(tenantId, dto, actor.id);
  }

  @Get('tenants/:id/messages')
  tenantHistory(@Param('id') tenantId: string) {
    return this.sender.history(tenantId);
  }

  // ─── Historial global y ajustes ─────────────────────────────────────────────

  @Get('messaging/outbox')
  outbox(@Query('tenantId') tenantId?: string) {
    return this.sender.history(tenantId);
  }

  @Get('messaging/settings')
  @ApiOperation({ summary: 'Config de mensajería (sin la API key en claro)' })
  getSettings() {
    return this.settings.getPublic();
  }

  @Patch('messaging/settings')
  updateSettings(@Body() dto: UpdateMessagingSettingsDto) {
    return this.settings.update(dto);
  }
}
