import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Inject,
  Injectable,
  Logger,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TenantContext } from '../auth/types/tenant-context.interface';
import { PLATFORM_SESSION_TENANT_ID } from './whatsapp-session.manager';
import { SendGuard } from './send-guard';
import { CO_LOCALE, CO_TZ, formatCOP, formatDateLongCO } from '../common/date.util';
import {
  IMessagingProvider,
  MESSAGING_PROVIDER,
} from './providers/messaging-provider.interface';
import {
  BranchPaymentInfoPayload,
  renderPaymentMethods,
} from './templates/payment-methods.template';
import { WhatsappTemplatesService } from './whatsapp-templates.service';
import { WhatsappTemplateKey } from './templates/message-templates';

export interface SendPaymentMethodsInput {
  to: string;
  /** Texto ya revisado por el cajero. Sin él se arma con el paymentInfo de la sede. */
  body?: string;
  amountCOP?: number;
  reference?: string;
  note?: string;
}

export interface NotifyAppointmentDto {
  customerName: string;
  customerPhone: string;
  serviceName: string;
  specialistName?: string;
  startTime: string;
  businessName: string;
  businessPhone?: string;
}

export interface OrderLineInput {
  name: string;
  quantity: number;
}

export interface NotifyOrderDto {
  customerName: string;
  customerPhone: string;
  /** Consecutivo o referencia visible del pedido. */
  orderCode?: string;
  items: OrderLineInput[];
  totalCOP: number;
  /** Cómo lo recibe: domicilio, recoge en tienda, dirección… */
  deliveryNote?: string;
  createdAt?: string;
  businessName: string;
  businessPhone?: string;
}

/** Lo único que necesita un envío: de qué negocio y por qué sede sale. */
export type SendContext = Pick<TenantContext, 'tenantId' | 'branchId'>;

export type SendTemplateResult = { id: string } | { skipped: true; reason: string };

/** El mismo aviso al mismo número no se repite dentro de esta ventana. */
const DEDUPE_WINDOW_MS = Number(process.env.WA_DEDUPE_WINDOW_MS ?? 600_000);
/** Camino público (reserva sin login): topes por hora. */
const PUBLIC_MAX_PER_TENANT_HOUR = Number(
  process.env.WA_PUBLIC_MAX_PER_TENANT_HOUR ?? 30,
);
const PUBLIC_MAX_PER_PHONE_HOUR = Number(
  process.env.WA_PUBLIC_MAX_PER_PHONE_HOUR ?? 3,
);
const HOUR_MS = 3_600_000;

/** Últimos 10 dígitos: compara '+57 300…' con '300…' sin pelear con el indicativo. */
const phoneTail = (raw?: string | null): string =>
  (raw ?? '').replace(/\D/g, '').slice(-10);

/** '…4567': suficiente para rastrear un envío en el log sin listar clientes. */
export const maskPhone = (raw: string): string => `…${phoneTail(raw).slice(-4)}`;

/** '3:45 p. m.' en hora Colombia. */
function formatClockCO(value: Date | string): string {
  return new Intl.DateTimeFormat(CO_LOCALE, {
    timeZone: CO_TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(value));
}

/** '2 x Camiseta negra, 1 x Gorra' */
function formatOrderLines(items: OrderLineInput[]): string {
  return items
    .filter((item) => item?.name)
    .map((item) => `${item.quantity} x ${item.name}`)
    .join(', ');
}

/**
 * Mensajería de WhatsApp del negocio hacia sus clientes.
 *
 * Ningún texto se arma aquí: el cuerpo sale de `WhatsappTemplatesService`, que
 * devuelve lo que el dueño editó en Ajustes o el default del código. Este
 * servicio solo resuelve los valores de los tokens y entrega al proveedor.
 *
 * `render` devuelve `null` cuando el negocio apagó ese aviso; en ese caso no se
 * envía nada y la respuesta lo dice, en vez de fallar.
 */
@Injectable()
export class WhatsAppService {
  private readonly logger = new Logger(WhatsAppService.name);
  private readonly guard = new SendGuard(DEDUPE_WINDOW_MS);

  constructor(
    @Inject(MESSAGING_PROVIDER) private readonly provider: IMessagingProvider,
    private readonly prisma: PrismaService,
    private readonly templates: WhatsappTemplatesService,
  ) {}

  private appointmentValues(
    dto: NotifyAppointmentDto,
  ): Record<string, string | undefined> {
    return {
      '{negocio}': dto.businessName,
      '{cliente}': dto.customerName,
      '{telefono}': dto.customerPhone,
      '{servicio}': dto.serviceName,
      '{fecha}': formatDateLongCO(dto.startTime),
      '{hora}': formatClockCO(dto.startTime),
      '{especialista}': dto.specialistName,
    };
  }

  private orderValues(dto: NotifyOrderDto): Record<string, string | undefined> {
    return {
      '{negocio}': dto.businessName,
      '{cliente}': dto.customerName,
      '{telefono}': dto.customerPhone,
      '{pedido}': dto.orderCode,
      '{productos}': formatOrderLines(dto.items ?? []),
      '{total}': formatCOP(dto.totalCOP ?? 0),
      '{fecha}': formatDateLongCO(dto.createdAt ?? new Date()),
      '{entrega}': dto.deliveryNote,
    };
  }

  /**
   * Renderiza y envía. Devuelve `skipped` cuando la plantilla está apagada, que
   * es una decisión del negocio y no un error, o cuando ese mismo aviso ya le
   * llegó a ese número hace poco (doble clic, remount, refresh).
   */
  private async sendTemplate(
    ctx: SendContext,
    key: WhatsappTemplateKey,
    to: string,
    values: Record<string, string | undefined>,
  ): Promise<SendTemplateResult> {
    const body = await this.templates.render(ctx.tenantId, key, values);
    if (!body) {
      return { skipped: true, reason: 'template_disabled' };
    }
    const fingerprint = [ctx.tenantId, ctx.branchId, key, phoneTail(to), body];
    if (this.guard.isDuplicate(fingerprint)) {
      this.logger.log(
        `Omitido ${key} a ${maskPhone(to)} (tenant ${ctx.tenantId}): duplicado reciente`,
      );
      return { skipped: true, reason: 'duplicate_recent' };
    }
    this.logger.log(`Enviando ${key} a ${maskPhone(to)} (tenant ${ctx.tenantId})`);
    const sent = await this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to,
      body,
    });
    this.guard.rememberSent(fingerprint);
    return sent;
  }

  /**
   * Reglas del camino público (confirmación de una reserva hecha sin login).
   *
   * Ahí no hay usuario que responda por el envío, así que solo se permite lo
   * mínimo: una sede real del tenant, con el aviso de WhatsApp encendido por el
   * propio negocio, y con tope de envíos por hora. El tenant de la plataforma
   * nunca entra por aquí.
   */
  private async assertPublicNotifyAllowed(
    ctx: SendContext,
    customerPhone: string,
    purpose: 'customer' | 'business',
  ): Promise<void> {
    if (!ctx.tenantId || !ctx.branchId) {
      throw new BadRequestException('X-Tenant-Id y X-Branch-Id son obligatorios');
    }
    if (ctx.tenantId === PLATFORM_SESSION_TENANT_ID) {
      throw new ForbiddenException();
    }
    const settings = await this.prisma.barberSettings.findUnique({
      where: { branchId: ctx.branchId },
      select: { tenantId: true, whatsappEnabled: true },
    });
    if (!settings || settings.tenantId !== ctx.tenantId) {
      throw new ForbiddenException('Sede no válida para este negocio');
    }
    if (!settings.whatsappEnabled) {
      throw new ForbiddenException(
        'El negocio no tiene activados los avisos por WhatsApp',
      );
    }
    const underTenantCap = this.guard.tryConsume(
      `public:${ctx.tenantId}`,
      PUBLIC_MAX_PER_TENANT_HOUR,
      HOUR_MS,
    );
    const underPhoneCap =
      underTenantCap &&
      this.guard.tryConsume(
        `public:${ctx.tenantId}:${purpose}:${phoneTail(customerPhone)}`,
        PUBLIC_MAX_PER_PHONE_HOUR,
        HOUR_MS,
      );
    if (!underTenantCap || !underPhoneCap) {
      this.logger.warn(
        `Tope de avisos públicos alcanzado (tenant ${ctx.tenantId}, ${maskPhone(customerPhone)})`,
      );
      throw new HttpException(
        'Demasiados avisos de WhatsApp, intenta más tarde',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }

  /**
   * Números que el negocio tiene registrados en la sede (ajustes y sitio
   * público). El camino público solo puede avisarle a uno de estos: si aceptara
   * cualquier `businessPhone`, la reserva pública serviría para escribirle a
   * quien sea con la plantilla del negocio.
   */
  private async storedBusinessPhone(
    ctx: SendContext,
    requested?: string,
  ): Promise<string | null> {
    const [settings, site] = await Promise.all([
      this.prisma.barberSettings.findUnique({
        where: { branchId: ctx.branchId },
        select: { phone: true, whatsapp: true },
      }),
      this.prisma.publicSite.findUnique({
        where: { branchId: ctx.branchId },
        select: { tenantId: true, phone: true, whatsapp: true },
      }),
    ]);
    const candidates = [
      settings?.whatsapp,
      settings?.phone,
      ...(site?.tenantId === ctx.tenantId ? [site.whatsapp, site.phone] : []),
    ].filter((p): p is string => !!phoneTail(p));
    if (requested) {
      return candidates.find((p) => phoneTail(p) === phoneTail(requested)) ?? null;
    }
    return candidates[0] ?? null;
  }

  /** Confirmación al cliente desde la reserva pública (sin login). */
  async sendPublicAppointmentConfirmation(
    ctx: SendContext,
    dto: NotifyAppointmentDto,
  ): Promise<SendTemplateResult> {
    await this.assertPublicNotifyAllowed(ctx, dto.customerPhone, 'customer');
    return this.sendAppointmentConfirmationToCustomer(ctx, dto);
  }

  /** Aviso al negocio desde la reserva pública: solo a un número de la sede. */
  async sendPublicAppointmentToBusiness(
    ctx: SendContext,
    dto: NotifyAppointmentDto,
  ): Promise<SendTemplateResult> {
    await this.assertPublicNotifyAllowed(ctx, dto.customerPhone, 'business');
    const businessPhone = await this.storedBusinessPhone(ctx, dto.businessPhone);
    if (!businessPhone) {
      return { skipped: true, reason: 'business_phone_not_registered' };
    }
    return this.sendAppointmentCreatedToBusiness(ctx, { ...dto, businessPhone });
  }

  async sendAppointmentCreatedToBusiness(
    ctx: SendContext,
    dto: NotifyAppointmentDto,
  ) {
    if (!dto.businessPhone) {
      throw new BadRequestException(
        'businessPhone is required to notify the business',
      );
    }
    return this.sendTemplate(
      ctx,
      'APPOINTMENT_BUSINESS',
      dto.businessPhone,
      this.appointmentValues(dto),
    );
  }

  async sendAppointmentConfirmationToCustomer(
    ctx: SendContext,
    dto: NotifyAppointmentDto,
  ) {
    return this.sendTemplate(
      ctx,
      'APPOINTMENT_CUSTOMER',
      dto.customerPhone,
      this.appointmentValues(dto),
    );
  }

  /** Retail: aviso al negocio de que entró un pedido del catálogo público. */
  async sendOrderCreatedToBusiness(ctx: SendContext, dto: NotifyOrderDto) {
    if (!dto.businessPhone) {
      throw new BadRequestException(
        'businessPhone is required to notify the business',
      );
    }
    return this.sendTemplate(
      ctx,
      'ORDER_BUSINESS',
      dto.businessPhone,
      this.orderValues(dto),
    );
  }

  /** Retail: confirmación del pedido al cliente que lo hizo. */
  async sendOrderConfirmationToCustomer(
    ctx: SendContext,
    dto: NotifyOrderDto,
  ) {
    return this.sendTemplate(
      ctx,
      'ORDER_CUSTOMER',
      dto.customerPhone,
      this.orderValues(dto),
    );
  }

  async sendRaw(
    ctx: SendContext,
    to: string,
    body: string,
  ): Promise<{ id: string }> {
    return this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to,
      body,
    });
  }

  /**
   * Manda al cliente cómo pagarle al negocio (llave Bre-B, billeteras, cuenta,
   * QR). Es agnóstico de vertical: los datos viven en la sede, así que sirve
   * igual para una mesa de restaurante, un corte o una venta de mostrador.
   *
   * No pasa por `WhatsappTemplatesService` a propósito: el cuerpo se arma con
   * los medios de pago configurados en la sede, no es un texto que el dueño
   * redacte.
   */
  async sendPaymentMethods(
    ctx: SendContext,
    input: SendPaymentMethodsInput,
  ): Promise<{ id: string }> {
    let body = input.body?.trim();

    if (!body) {
      const branch = await this.prisma.branch.findFirst({
        where: { id: ctx.branchId, tenantId: ctx.tenantId },
        select: { paymentInfo: true, tenant: { select: { name: true } } },
      });
      if (!branch) throw new BadRequestException('Branch not found');
      body = renderPaymentMethods({
        info: branch.paymentInfo as BranchPaymentInfoPayload | null,
        businessName: branch.tenant?.name,
        amountCOP: input.amountCOP,
        reference: input.reference,
        note: input.note,
      });
    }

    return this.provider.sendText({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      to: input.to,
      body,
    });
  }
}
