import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { TenantContext } from '../../../../auth/types/tenant-context.interface';
import { GoogleCalendarService } from './google-calendar.service';

const PUBLIC_BOOKING =
  /\/public\/barber\/branches\/([^/?]+)\/appointments(\?|$)/;
const BARBER_WRITE = /\/barber\/(?!integrations\/google-calendar)/;
const AGENDA_LOAD = /\/barber\/appointments(\?|$)/;

/**
 * Cualquier escritura exitosa de la agenda pide reconciliar Google.
 *
 * Se mira la ruta y no cada servicio a propósito: citas, clases, reservas
 * fijas, cobros, clientes y servicios borrados tocan la agenda por caminos
 * distintos, y engancharlos uno por uno deja siempre alguno por fuera. La
 * reconciliación compara hashes, así que un disparo de más no llama a Google.
 */
@Injectable()
export class GoogleCalendarSyncInterceptor implements NestInterceptor {
  constructor(private readonly calendar: GoogleCalendarService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const req = context
      .switchToHttp()
      .getRequest<Request & { tenantContext?: TenantContext }>();
    const url = req.originalUrl;

    let trigger: (() => void) | null = null;
    const publicBooking =
      req.method === 'POST' ? PUBLIC_BOOKING.exec(url) : null;
    if (publicBooking) {
      trigger = () => this.calendar.requestSync(publicBooking[1]);
    } else if (req.tenantContext && !url.includes('/public/')) {
      const branchId = req.tenantContext.branchId;
      if (req.method === 'GET' && AGENDA_LOAD.test(url)) {
        trigger = () => this.calendar.softSync(branchId);
      } else if (req.method !== 'GET' && BARBER_WRITE.test(url)) {
        trigger = () => this.calendar.requestSync(branchId);
      }
    }
    if (!trigger) return next.handle();
    return next.handle().pipe(tap({ next: trigger }));
  }
}
