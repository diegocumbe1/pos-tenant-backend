import { ForbiddenException, Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../auth/types/tenant-context.interface';
import { PlatformService } from '../platform/platform.service';
import { RetailSalesService } from '../retail/modules/sales/retail-sales.service';
import { AssistantScopeService, BusinessRef } from './assistant-scope.service';
import {
  PendingPaymentAnswer,
  PlatformOverviewAnswer,
} from './assistant.types';

/**
 * Capacidad de consulta compartida entre canales (Alexa, chat web).
 *
 * Responsabilidades: verificar permisos del actor y devolver cifras. La
 * redacción —hablada o en pantalla— es del canal, no de aquí.
 */
@Injectable()
export class AssistantService {
  constructor(
    private readonly platform: PlatformService,
    private readonly scope: AssistantScopeService,
    private readonly retailSales: RetailSalesService,
  ) {}

  /** Saldos pendientes actuales de un negocio, no vencimientos del día. */
  async pendingPayment(
    actor: AuthenticatedUser,
    business: BusinessRef,
  ): Promise<PendingPaymentAnswer> {
    const ctx = await this.scope.contextFor(actor, business.id);
    this.scope.assertPermission(ctx, 'retail:sales:read');
    const debt = await this.retailSales.pendingPaymentByCustomer(ctx);
    return { business, ...debt };
  }

  /** Consulta de ámbito plataforma: exige `isPlatformAdmin`, como `/platform/*`. */
  async platformOverview(
    actor: AuthenticatedUser,
  ): Promise<PlatformOverviewAnswer> {
    if (!actor.isPlatformAdmin) {
      throw new ForbiddenException('Platform admin privileges required');
    }
    const overview = await this.platform.getOverview();
    const tenants = overview.tenants.byStatus;
    const subs = overview.subscriptions.byStatus;
    const count = (source: Record<string, number>, key: string) =>
      source[key] ?? 0;

    return {
      tenants: {
        total: overview.tenants.total,
        active: count(tenants, 'ACTIVE'),
        suspended: count(tenants, 'SUSPENDED'),
      },
      subscriptions: {
        active: count(subs, 'ACTIVE'),
        trialing: count(subs, 'TRIALING'),
        pastDue: count(subs, 'PAST_DUE'),
        billable:
          count(subs, 'ACTIVE') +
          count(subs, 'TRIALING') +
          count(subs, 'PAST_DUE'),
      },
      mrrCOP: overview.subscriptions.mrrCOP,
      payments: {
        month: overview.payments.month,
        count: overview.payments.count,
        totalCOP: overview.payments.totalAmount,
      },
    };
  }
}
