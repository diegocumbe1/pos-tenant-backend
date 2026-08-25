import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Post,
  Query,
  Sse,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject } from 'rxjs';
import { filter, map } from 'rxjs/operators';
import { WhatsAppService } from './whatsapp.service';
import { WhatsAppSessionManager } from './whatsapp-session.manager';
import {
  NotifyAppointmentBodyDto,
  SendTestMessageDto,
} from './dto/notify-appointment.dto';
import { SendPaymentMethodsDto } from './dto/send-payment-methods.dto';

interface StatusEvent {
  tenantId: string;
  branchId: string;
  status: string;
  qr?: string;
  phoneNumber?: string;
  error?: string;
}

interface SessionContextBody {
  tenantId?: string;
  branchId?: string;
}

// [DEMO] Auth is not wired yet on the frontend. For the demo we read tenant/branch
// from X-Tenant-Id / X-Branch-Id headers (or ?tenantId/?branchId for the SSE stream,
// since EventSource cannot send custom headers). Falls back to the demo barber IDs
// so the endpoints are usable without a session store configured.
const DEMO_TENANT_ID = 'tenant-barber-001';
const DEMO_BRANCH_ID = 'branch-barber-001';

function resolveCtx(
  headerTenant?: string,
  headerBranch?: string,
  queryTenant?: string,
  queryBranch?: string,
  bodyTenant?: string,
  bodyBranch?: string,
): { tenantId: string; branchId: string } {
  return {
    tenantId: headerTenant ?? queryTenant ?? bodyTenant ?? DEMO_TENANT_ID,
    branchId: headerBranch ?? queryBranch ?? bodyBranch ?? DEMO_BRANCH_ID,
  };
}

@ApiTags('WhatsApp')
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

  @Post('session/pair')
  @HttpCode(HttpStatus.ACCEPTED)
  pair(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
    @Query('tenantId') queryTenant?: string,
    @Query('branchId') queryBranch?: string,
    @Body() body?: SessionContextBody,
  ) {
    const ctx = resolveCtx(
      tenantId,
      branchId,
      queryTenant,
      queryBranch,
      body?.tenantId,
      body?.branchId,
    );
    return this.sessions.pair(ctx.tenantId, ctx.branchId);
  }

  @Get('session/status')
  status(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
    @Query('tenantId') queryTenant?: string,
    @Query('branchId') queryBranch?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId, queryTenant, queryBranch);
    return this.sessions.getStatus(ctx.tenantId, ctx.branchId);
  }

  @Get('session/diagnostics')
  diagnostics(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
    @Query('tenantId') queryTenant?: string,
    @Query('branchId') queryBranch?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId, queryTenant, queryBranch);
    return this.sessions.getDiagnostics(ctx.tenantId, ctx.branchId);
  }

  @Sse('session/stream')
  stream(
    @Headers('x-tenant-id') headerTenant?: string,
    @Headers('x-branch-id') headerBranch?: string,
    @Query('tenantId') queryTenant?: string,
    @Query('branchId') queryBranch?: string,
  ): Observable<MessageEvent> {
    const ctx = resolveCtx(headerTenant, headerBranch, queryTenant, queryBranch);
    const initial = this.sessions.getStatus(ctx.tenantId, ctx.branchId);
    const initialEvent: StatusEvent = {
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      status: initial.status,
      qr: initial.qr,
      phoneNumber: initial.phoneNumber,
      error: initial.error,
    };
    return new Observable<MessageEvent>((subscriber) => {
      subscriber.next({ data: initialEvent } as MessageEvent);
      const heartbeat = setInterval(() => {
        const current = this.sessions.getStatus(ctx.tenantId, ctx.branchId);
        subscriber.next({
          data: {
            tenantId: ctx.tenantId,
            branchId: ctx.branchId,
            status: current.status,
            qr: current.qr,
            phoneNumber: current.phoneNumber,
            error: current.error,
          },
        } as MessageEvent);
      }, 25000);
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
  disconnect(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
    @Query('tenantId') queryTenant?: string,
    @Query('branchId') queryBranch?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId, queryTenant, queryBranch);
    return this.sessions.disconnect(ctx.tenantId, ctx.branchId);
  }

  @Post('session/reset')
  @HttpCode(HttpStatus.OK)
  async reset(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
    @Query('tenantId') queryTenant?: string,
    @Query('branchId') queryBranch?: string,
    @Body() body?: SessionContextBody,
  ) {
    const ctx = resolveCtx(
      tenantId,
      branchId,
      queryTenant,
      queryBranch,
      body?.tenantId,
      body?.branchId,
    );
    await this.sessions.disconnect(ctx.tenantId, ctx.branchId);
    return this.sessions.getDiagnostics(ctx.tenantId, ctx.branchId);
  }

  @Delete('session/local-auth')
  @HttpCode(HttpStatus.NO_CONTENT)
  clearLocalAuth(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
    @Query('tenantId') queryTenant?: string,
    @Query('branchId') queryBranch?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId, queryTenant, queryBranch);
    return this.sessions.disconnect(ctx.tenantId, ctx.branchId);
  }

  @Post('appointments/notify-business')
  @HttpCode(HttpStatus.OK)
  notifyBusiness(
    @Body() dto: NotifyAppointmentBodyDto,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId);
    return this.whatsapp.sendAppointmentCreatedToBusiness(ctx as any, dto);
  }

  @Post('appointments/notify-customer')
  @HttpCode(HttpStatus.OK)
  notifyCustomer(
    @Body() dto: NotifyAppointmentBodyDto,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId);
    return this.whatsapp.sendAppointmentConfirmationToCustomer(ctx as any, dto);
  }

  // Medios de pago al cliente (Bre-B, Nequi, cuenta, QR) desde el WhatsApp del
  // negocio. Lo usan los tres verticals: el dato vive en la sede.
  @Post('payment-methods')
  @HttpCode(HttpStatus.OK)
  sendPaymentMethods(
    @Body() dto: SendPaymentMethodsDto,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId);
    return this.whatsapp.sendPaymentMethods(ctx as any, dto);
  }

  @Post('test')
  @HttpCode(HttpStatus.OK)
  test(
    @Body() dto: SendTestMessageDto,
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId);
    return this.whatsapp.sendRaw(ctx as any, dto.to, dto.body);
  }
}
