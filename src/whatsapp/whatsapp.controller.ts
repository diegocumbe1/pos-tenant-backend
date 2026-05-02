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

interface StatusEvent {
  tenantId: string;
  branchId: string;
  status: string;
  qr?: string;
  phoneNumber?: string;
  error?: string;
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
): { tenantId: string; branchId: string } {
  return {
    tenantId: headerTenant ?? queryTenant ?? DEMO_TENANT_ID,
    branchId: headerBranch ?? queryBranch ?? DEMO_BRANCH_ID,
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
  ) {
    const ctx = resolveCtx(tenantId, branchId);
    return this.sessions.pair(ctx.tenantId, ctx.branchId);
  }

  @Get('session/status')
  status(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId);
    return this.sessions.getStatus(ctx.tenantId, ctx.branchId);
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
      const sub = this.status$
        .pipe(
          filter(
            (e) => e.tenantId === ctx.tenantId && e.branchId === ctx.branchId,
          ),
          map((e) => ({ data: e }) as MessageEvent),
        )
        .subscribe((msg) => subscriber.next(msg));
      return () => sub.unsubscribe();
    });
  }

  @Delete('session')
  @HttpCode(HttpStatus.NO_CONTENT)
  disconnect(
    @Headers('x-tenant-id') tenantId?: string,
    @Headers('x-branch-id') branchId?: string,
  ) {
    const ctx = resolveCtx(tenantId, branchId);
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
