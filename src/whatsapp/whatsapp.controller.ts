import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiSecurity, ApiTags } from '@nestjs/swagger';
import { OnEvent } from '@nestjs/event-emitter';
import { Request } from 'express';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { PasswordSetGuard } from '../auth/guards/password-set.guard';
import { TenantGuard } from '../auth/guards/tenant.guard';
import { CurrentTenant } from '../auth/decorators/current-tenant.decorator';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { SendContext, WhatsAppService } from './whatsapp.service';
import {
  PLATFORM_SESSION_TENANT_ID,
  WhatsAppSessionManager,
} from './whatsapp-session.manager';
import { OptionalTenantAuthGuard } from './guards/optional-tenant-auth.guard';
import {
  NotifyAppointmentBodyDto,
  SendTestMessageDto,
} from './dto/notify-appointment.dto';
import { SendPaymentMethodsDto } from './dto/send-payment-methods.dto';
import { NotifyOrderBodyDto } from './dto/notify-order.dto';

interface StatusEvent {
  tenantId: string;
  branchId: string;
  status: string;
  qr?: string;
  phoneNumber?: string;
  error?: string;
}

/**
 * El WhatsApp del negocio, operado por el propio negocio.
 *
 * Antes este controller no tenía guards: tomaba el tenant de headers/query y,
 * sin ellos, caía en los IDs de demo. Cualquiera con la URL podía enviar texto
 * libre desde el número de cualquier tenant —incluido el de Lynko, pasando el
 * tenant sentinel—, ver su QR o desvincularlo. Ahora:
 *
 *  - Todo sale del JWT (`TenantGuard`), sin fallback a demo.
 *  - La sesión de la plataforma no se toca desde aquí; tiene su consola en
 *    `/platform/messaging/*`, solo para super-admin.
 *  - Los dos avisos de cita aceptan además el camino público de la reserva sin
 *    login, con reglas restringidas (ver `WhatsAppService.sendPublic*`).
 */
@ApiTags('WhatsApp')
@ApiBearerAuth()
@ApiSecurity('X-Tenant-Id')
@ApiSecurity('X-Branch-Id')
@Controller('whatsapp')
export class WhatsAppController {
  private readonly status$ = new Subject<StatusEvent>();

  constructor(
    private readonly whatsapp: WhatsAppService,
    private readonly sessions: WhatsAppSessionManager,
  ) {}

  @OnEvent('wa.status')
  onStatusEvent(payload: StatusEvent) {
    this.status$.next(payload);
  }

  // ─── Sesión ─────────────────────────────────────────────────────────────────

  @Post('session/pair')
  @HttpCode(HttpStatus.ACCEPTED)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  pair(@CurrentTenant() ctx: TenantContext) {
    const { tenantId, branchId } = sessionOf(ctx);
    return this.sessions.pair(tenantId, branchId);
  }

  @Get('session/status')
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  status(@CurrentTenant() ctx: TenantContext) {
    const { tenantId, branchId } = sessionOf(ctx);
    return this.sessions.getStatus(tenantId, branchId);
  }

  @Get('session/diagnostics')
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  diagnostics(@CurrentTenant() ctx: TenantContext) {
    const { tenantId, branchId } = sessionOf(ctx);
    return this.sessions.getDiagnostics(tenantId, branchId);
  }

  /**
   * Stream de estado. Exige JWT igual que el resto, así que `EventSource` (que
   * no manda headers) ya no puede usarlo: el frontend hace polling de
   * `session/status`. Queda para clientes que sí pueden autenticarse.
   */
  @Sse('session/stream')
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  stream(@CurrentTenant() tenantCtx: TenantContext): Observable<MessageEvent> {
    const ctx = sessionOf(tenantCtx);
    const snapshot = (): StatusEvent => {
      const current = this.sessions.getStatus(ctx.tenantId, ctx.branchId);
      return {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        status: current.status,
        qr: current.qr,
        phoneNumber: current.phoneNumber,
        error: current.error,
      };
    };
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ data: snapshot() } as MessageEvent);
      const heartbeat = setInterval(
        () => subscriber.next({ data: snapshot() } as MessageEvent),
        25000,
      );
      const sub = this.status$
        .pipe(
          filter(
            (e) => e.tenantId === ctx.tenantId && e.branchId === ctx.branchId,
          ),
          map((e) => ({ data: e }) as MessageEvent),
        )
        .subscribe((msg) => subscriber.next(msg));
      return () => {
        clearInterval(heartbeat);
        sub.unsubscribe();
      };
    });
  }

  @Delete('session')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  disconnect(@CurrentTenant() ctx: TenantContext) {
    const { tenantId, branchId } = sessionOf(ctx);
    return this.sessions.disconnect(tenantId, branchId);
  }

  @Post('session/reset')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  async reset(@CurrentTenant() ctx: TenantContext) {
    const { tenantId, branchId } = sessionOf(ctx);
    await this.sessions.disconnect(tenantId, branchId);
    return this.sessions.getDiagnostics(tenantId, branchId);
  }

  @Delete('session/local-auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  clearLocalAuth(@CurrentTenant() ctx: TenantContext) {
    const { tenantId, branchId } = sessionOf(ctx);
    return this.sessions.disconnect(tenantId, branchId);
  }

  // ─── Avisos de cita (POS con sesión o reserva pública) ──────────────────────

  @Post('appointments/notify-business')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalTenantAuthGuard)
  notifyBusiness(
    @Body() dto: NotifyAppointmentBodyDto,
    @Req() req: Request & { tenantContext?: TenantContext },
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    if (req.tenantContext) {
      return this.whatsapp.sendAppointmentCreatedToBusiness(
        sessionOf(req.tenantContext),
        dto,
      );
    }
    return this.whatsapp.sendPublicAppointmentToBusiness(
      publicContext(tenantId, branchId),
      dto,
    );
  }

  @Post('appointments/notify-customer')
  @HttpCode(HttpStatus.OK)
  @UseGuards(OptionalTenantAuthGuard)
  notifyCustomer(
    @Body() dto: NotifyAppointmentBodyDto,
    @Req() req: Request & { tenantContext?: TenantContext },
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    if (req.tenantContext) {
      return this.whatsapp.sendAppointmentConfirmationToCustomer(
        sessionOf(req.tenantContext),
        dto,
      );
    }
    return this.whatsapp.sendPublicAppointmentConfirmation(
      publicContext(tenantId, branchId),
      dto,
    );
  }

  // ─── Envíos desde el panel del negocio (solo con sesión) ───────────────────

  // Retail: pedidos del catálogo público. Mismo par que en citas —uno avisa a la
  // tienda, otro le confirma al cliente— pero con la plantilla de pedido. Hoy
  // ninguna pantalla los llama; quedan detrás de JWT hasta que el backend los
  // dispare solo.
  @Post('orders/notify-business')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  notifyOrderBusiness(
    @Body() dto: NotifyOrderBodyDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    return this.whatsapp.sendOrderCreatedToBusiness(sessionOf(ctx), dto);
  }

  @Post('orders/notify-customer')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  notifyOrderCustomer(
    @Body() dto: NotifyOrderBodyDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    return this.whatsapp.sendOrderConfirmationToCustomer(sessionOf(ctx), dto);
  }

  // Medios de pago al cliente (Bre-B, Nequi, cuenta, QR) desde el WhatsApp del
  // negocio. Lo usan los tres verticals: el dato vive en la sede.
  @Post('payment-methods')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  sendPaymentMethods(
    @Body() dto: SendPaymentMethodsDto,
    @CurrentTenant() ctx: TenantContext,
  ) {
    return this.whatsapp.sendPaymentMethods(sessionOf(ctx), dto);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  @UseGuards(JwtAuthGuard, PasswordSetGuard, TenantGuard)
  test(@Body() dto: SendTestMessageDto, @CurrentTenant() ctx: TenantContext) {
    return this.whatsapp.sendRaw(sessionOf(ctx), dto.to, dto.body);
  }
}

/**
 * Sesión del tenant autenticado. La sesión es por sede, así que sin
 * X-Branch-Id no hay a cuál apuntar. ROOT puede impersonar tenants con
 * TenantGuard, pero la sesión de la plataforma no se opera desde aquí.
 */
function sessionOf(ctx: TenantContext): SendContext {
  if (ctx.tenantId === PLATFORM_SESSION_TENANT_ID) {
    throw new ForbiddenException(
      'La sesión de la plataforma se gestiona desde /platform/messaging',
    );
  }
  if (!ctx.branchId) {
    throw new BadRequestException('X-Branch-Id es obligatorio para WhatsApp');
  }
  return { tenantId: ctx.tenantId, branchId: ctx.branchId };
}

/** Contexto del camino público: headers explícitos, sin fallback a demo. */
function publicContext(tenantId?: string, branchId?: string): SendContext {
  if (!tenantId || !branchId) {
    throw new BadRequestException('X-Tenant-Id y X-Branch-Id son obligatorios');
  }
  return { tenantId, branchId };
}
