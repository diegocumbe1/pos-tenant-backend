import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, QrCode, QrCodeType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreateQrCodeDto, UpdateQrCodeDto } from './dto/qr.dto';
import {
  assertValidQrTarget,
  buildQrCode,
  buildQrScanUrl,
  resolveQrTarget,
} from './qr-code.util';

/** Marca del QR con la que se pinta la tarjeta, ya resuelta desde el negocio. */
export interface QrBrandingView {
  businessName: string;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  city: string | null;
  /** Sugerencias para los campos vacíos de la tarjeta. */
  defaultSubtitle: string | null;
  defaultCta: string;
}

export interface QrCodeView {
  id: string;
  code: string;
  type: QrCodeType;
  tenantId: string | null;
  branchId: string | null;
  /**
   * Tal como se guardó: puede ser relativo. Es lo que edita el formulario.
   * null en `PAYMENT`: esa escarapela no redirige a ningún lado.
   */
  targetUrl: string | null;
  /** Absoluto, ya resuelto contra PUBLIC_APP_URL. Es a donde se redirige. */
  resolvedTargetUrl: string | null;
  /** Lo que va DENTRO del QR. Nunca cambia mientras no se revoque. */
  scanUrl: string;
  active: boolean;
  card: {
    title: string | null;
    subtitle: string | null;
    cta: string | null;
  };
  createdAt: string;
  updatedAt: string;
}

export interface QrCodePanelView {
  /** null = el negocio todavía no tiene QR permanente. */
  qr: QrCodeView | null;
  /** Destino propuesto cuando aún no hay QR (o cuando el actual quedó viejo). */
  suggestedTargetUrl: string;
  branding: QrBrandingView;
  /** Base pública de este entorno; el front arma links sin adivinarla. */
  baseUrl: string;
}

/**
 * Los datos de cobro de una sede, tal como los ve quien escanea la escarapela.
 *
 * `paymentInfo` va crudo a propósito: el front ya sabe leer esa forma
 * (`shared/payments/payment-methods.ts`, que usan el POS, el recibo y Ajustes),
 * y normalizarla otra vez acá garantizaría que las dos copias se separen.
 */
export interface QrPaymentView {
  businessName: string;
  branchName: string | null;
  logoUrl: string | null;
  primaryColor: string;
  accentColor: string;
  paymentInfo: Prisma.JsonValue;
  /** Instrucción del negocio bajo el QR, si la escribió. */
  note: string | null;
}

/**
 * Qué hacer con un código escaneado.
 *
 * Es una unión y no una URL suelta porque hay dos clases de QR: los que mandan
 * a otro lado y la escarapela de cobro, que la pinta Lynko. Meter la segunda en
 * la primera obligaba a guardar en `targetUrl` una ruta que contiene el propio
 * código — y que por lo tanto se rompe justo al revocarlo.
 */
export type QrResolution =
  | { kind: 'redirect'; targetUrl: string }
  | { kind: 'payment'; payment: QrPaymentView };

/** Dueño del QR de la landing: no es de ningún tenant ni de ninguna sede. */
const PLATFORM_SCOPE = 'platform';

/**
 * Campos de `Branch.paymentInfo` que NO salen en la página pública.
 *
 * `documentId` es la cédula del titular. El negocio la puso para que salga en
 * el recibo de un cliente que ya le compró, no para publicarla en una URL que
 * cualquiera puede abrir. Quien la necesite para transferir se la pide.
 */
const PRIVATE_PAYMENT_FIELDS = ['documentId'] as const;

const DEFAULT_CTA = 'Escanea y conoce nuestro catálogo';
const LYNKO_PRIMARY = '#6366f1';
const LYNKO_ACCENT = '#22c55e';

/** Cuántas veces se reintenta si el código aleatorio ya existía. */
const CODE_COLLISION_RETRIES = 5;

/**
 * QR permanentes: la capa de indirección entre el cartón impreso y la web.
 *
 * Regla que manda sobre todas las demás: `code` es inmutable salvo revocación
 * explícita. Todo lo que se pueda cambiar (destino, textos, estado) se cambia
 * SIN tocarlo, porque el código ya está en tarjetas, stickers y empaques que
 * nadie va a reimprimir.
 */
@Injectable()
export class QrService {
  private readonly logger = new Logger(QrService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─── Lectura pública ────────────────────────────────────────────────────────

  /**
   * Resuelve un código escaneado. Lo consume `/q/:code` del front.
   *
   * Devuelve SOLO el destino: ni tenantId, ni ids internos, ni el motivo por el
   * que un código no sirve. Para quien escanea, "no existe" y "lo desactivaron"
   * son la misma página, y el 404 no le cuenta a un tercero qué negocios hay.
   */
  async resolve(code: string): Promise<QrResolution> {
    const qr = await this.prisma.qrCode.findUnique({
      where: { code },
      select: {
        type: true,
        targetUrl: true,
        active: true,
        branchId: true,
        cardCta: true,
      },
    });

    if (!qr || !qr.active) throw this.unavailable();

    if (qr.type === QrCodeType.PAYMENT) {
      return { kind: 'payment', payment: await this.paymentViewOf(qr.branchId, qr.cardCta) };
    }

    // Un QR de redirección sin destino no debería existir; si pasa, para quien
    // escanea es un enlace que no sirve, no un error 500.
    if (!qr.targetUrl) throw this.unavailable();

    return {
      kind: 'redirect',
      targetUrl: resolveQrTarget(qr.targetUrl, this.baseUrl()),
    };
  }

  /** Datos de cobro de la sede, ya filtrados para publicación. */
  private async paymentViewOf(
    branchId: string | null,
    note: string | null,
  ): Promise<QrPaymentView> {
    if (!branchId) throw this.unavailable();

    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        name: true,
        paymentInfo: true,
        tenantId: true,
        tenant: { select: { name: true } },
      },
    });
    if (!branch) throw this.unavailable();

    const branding = await this.brandingOf(branch.tenantId, branch.tenant.name);

    return {
      businessName: branding.businessName,
      // Una sola sede no necesita nombre en la escarapela; con varias, saber
      // cuál es evita que el cliente pague a la caja del otro local.
      branchName: branch.name,
      logoUrl: branding.logoUrl,
      primaryColor: branding.primaryColor,
      accentColor: branding.accentColor,
      paymentInfo: stripPrivateFields(branch.paymentInfo),
      note,
    };
  }

  private unavailable(): NotFoundException {
    return new NotFoundException({
      code: 'QR_NOT_AVAILABLE',
      message: 'Este enlace ya no se encuentra disponible.',
    });
  }

  // ─── Backoffice: QR de un tenant ────────────────────────────────────────────

  async getForTenant(tenantId: string): Promise<QrCodePanelView> {
    const tenant = await this.requireTenant(tenantId);
    const [qr, branding, suggestedTargetUrl] = await Promise.all([
      this.prisma.qrCode.findUnique({
        where: { scopeId_type: { scopeId: tenantId, type: QrCodeType.BUSINESS_CARD } },
      }),
      this.brandingOf(tenantId, tenant.name),
      this.suggestTargetFor(tenantId),
    ]);

    return {
      qr: qr ? this.toView(qr) : null,
      suggestedTargetUrl,
      branding,
      baseUrl: this.baseUrl(),
    };
  }

  /**
   * Crea el QR del tenant. IDEMPOTENTE: si ya existe lo devuelve tal cual.
   *
   * Dos pestañas abiertas apretando "Generar" es el caso normal, no el raro, y
   * la segunda NO puede acabar con un código distinto: el primero ya podría
   * estar impreso. La carrera la corta el índice único de la base (P2002), no
   * un chequeo previo que siempre tiene una ventana.
   */
  async createForTenant(
    tenantId: string,
    dto: CreateQrCodeDto,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const tenant = await this.requireTenant(tenantId);
    const existing = await this.prisma.qrCode.findUnique({
      where: { scopeId_type: { scopeId: tenantId, type: QrCodeType.BUSINESS_CARD } },
    });
    if (existing) return this.toView(existing);

    const targetUrl = dto.targetUrl
      ? this.validTarget(dto.targetUrl)
      : await this.suggestTargetFor(tenantId);

    const created = await this.createWithUniqueCode({
      name: tenant.name,
      type: QrCodeType.BUSINESS_CARD,
      scopeId: tenantId,
      tenantId,
      targetUrl,
    });

    await this.audit(actorUserId, 'tenant.qr.created', created.id, null, {
      tenantId,
      code: created.code,
      targetUrl: created.targetUrl,
    });

    return this.toView(created);
  }

  async updateForTenant(
    tenantId: string,
    dto: UpdateQrCodeDto,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const current = await this.requireQr(tenantId, QrCodeType.BUSINESS_CARD);
    return this.applyUpdate(current, dto, actorUserId);
  }

  /**
   * Rota el código: el anterior deja de existir y todo lo impreso muere.
   *
   * Se hace rotando la MISMA fila en vez de creando otra: así no quedan dos
   * códigos vivos para el mismo negocio ni hay que decidir cuál gana.
   */
  async revokeForTenant(
    tenantId: string,
    reason: string,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const tenant = await this.requireTenant(tenantId);
    const current = await this.requireQr(tenantId, QrCodeType.BUSINESS_CARD);
    return this.rotateCode(current, tenant.name, reason, actorUserId);
  }

  // ─── Backoffice: QR de la propia Lynko ──────────────────────────────────────

  async getPlatform(): Promise<QrCodePanelView> {
    const qr = await this.findPlatformQr();
    return {
      qr: qr ? this.toView(qr) : null,
      suggestedTargetUrl: '/',
      branding: this.lynkoBranding(),
      baseUrl: this.baseUrl(),
    };
  }

  async createPlatform(
    dto: CreateQrCodeDto,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const existing = await this.findPlatformQr();
    if (existing) return this.toView(existing);

    const created = await this.createWithUniqueCode({
      name: 'lynko',
      type: QrCodeType.PLATFORM,
      scopeId: PLATFORM_SCOPE,
      tenantId: null,
      targetUrl: dto.targetUrl ? this.validTarget(dto.targetUrl) : '/',
    });

    await this.audit(actorUserId, 'platform.qr.created', created.id, null, {
      code: created.code,
      targetUrl: created.targetUrl,
    });

    return this.toView(created);
  }

  async updatePlatform(
    dto: UpdateQrCodeDto,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const current = await this.findPlatformQr();
    if (!current) throw new NotFoundException('La plataforma no tiene QR');
    return this.applyUpdate(current, dto, actorUserId);
  }

  async revokePlatform(
    reason: string,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const current = await this.findPlatformQr();
    if (!current) throw new NotFoundException('La plataforma no tiene QR');
    return this.rotateCode(current, 'lynko', reason, actorUserId);
  }

  // ─── App del negocio: escarapela de cobro de una sede ───────────────────────

  /**
   * El QR de cobro es de la SEDE, no del tenant: cada local puede cobrar a una
   * cuenta distinta, y una escarapela que mandara a la cuenta del otro local
   * sería plata en el bolsillo equivocado.
   */
  async getForBranch(
    tenantId: string,
    branchId: string,
  ): Promise<QrCodePanelView> {
    const branch = await this.requireBranch(tenantId, branchId);
    const [qr, branding] = await Promise.all([
      this.prisma.qrCode.findUnique({
        where: { scopeId_type: { scopeId: branchId, type: QrCodeType.PAYMENT } },
      }),
      this.brandingOf(tenantId, branch.tenantName),
    ]);

    return {
      qr: qr ? this.toView(qr) : null,
      // La escarapela no redirige: el destino es la página que pinta Lynko.
      suggestedTargetUrl: '',
      branding,
      baseUrl: this.baseUrl(),
    };
  }

  /** Idempotente, igual que el de la tarjeta: nunca devuelve un código nuevo. */
  async createForBranch(
    tenantId: string,
    branchId: string,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const branch = await this.requireBranch(tenantId, branchId);

    const existing = await this.prisma.qrCode.findUnique({
      where: { scopeId_type: { scopeId: branchId, type: QrCodeType.PAYMENT } },
    });
    if (existing) return this.toView(existing);

    // Sin ningún dato de cobro cargado, la escarapela sería un QR que lleva a
    // una página vacía. Mejor decirlo acá que dejar que lo descubra un cliente
    // con el celular en la mano frente a la caja.
    if (!hasAnyPaymentData(branch.paymentInfo)) {
      throw new BadRequestException({
        code: 'NO_PAYMENT_METHODS',
        message:
          'Esta sede no tiene medios de pago cargados. Agrega tu llave Bre-B, Nequi o cuenta antes de generar la escarapela.',
      });
    }

    const created = await this.createWithUniqueCode({
      name: branch.tenantName,
      type: QrCodeType.PAYMENT,
      scopeId: branchId,
      tenantId,
      branchId,
      targetUrl: null,
    });

    await this.audit(actorUserId, 'tenant.qr.payment_created', created.id, null, {
      tenantId,
      branchId,
      code: created.code,
    });

    return this.toView(created);
  }

  async updateForBranch(
    tenantId: string,
    branchId: string,
    dto: UpdateQrCodeDto,
    actorUserId: string,
  ): Promise<QrCodeView> {
    await this.requireBranch(tenantId, branchId);
    const current = await this.requireQr(branchId, QrCodeType.PAYMENT);

    // `targetUrl` no aplica: esta escarapela no manda a ningún lado. Aceptarlo
    // en silencio dejaría una ruta guardada que nadie lee y que el día de
    // mañana alguien creería que funciona.
    if (dto.targetUrl !== undefined) {
      throw new BadRequestException(
        'La escarapela de cobro no tiene destino configurable.',
      );
    }

    return this.applyUpdate(current, dto, actorUserId);
  }

  async revokeForBranch(
    tenantId: string,
    branchId: string,
    reason: string,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const branch = await this.requireBranch(tenantId, branchId);
    const current = await this.requireQr(branchId, QrCodeType.PAYMENT);
    return this.rotateCode(current, branch.tenantName, reason, actorUserId);
  }

  private async requireBranch(
    tenantId: string,
    branchId: string,
  ): Promise<{ tenantName: string; paymentInfo: Prisma.JsonValue }> {
    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: {
        tenantId: true,
        paymentInfo: true,
        tenant: { select: { name: true } },
      },
    });
    // El `tenantId` del contexto manda: sin esta comparación, mandar el id de
    // una sede ajena en la URL leería los datos de cobro de otro negocio.
    if (!branch || branch.tenantId !== tenantId) {
      throw new NotFoundException('Sede no encontrada');
    }
    return { tenantName: branch.tenant.name, paymentInfo: branch.paymentInfo };
  }

  // ─── Interno ────────────────────────────────────────────────────────────────

  private async applyUpdate(
    current: QrCode,
    dto: UpdateQrCodeDto,
    actorUserId: string,
  ): Promise<QrCodeView> {
    const data: Prisma.QrCodeUpdateInput = {};

    if (dto.targetUrl !== undefined) {
      data.targetUrl = this.validTarget(dto.targetUrl);
    }
    if (dto.active !== undefined) data.active = dto.active;
    if (dto.cardTitle !== undefined) data.cardTitle = trimOrNull(dto.cardTitle);
    if (dto.cardSubtitle !== undefined) {
      data.cardSubtitle = trimOrNull(dto.cardSubtitle);
    }
    if (dto.cardCta !== undefined) data.cardCta = trimOrNull(dto.cardCta);

    if (Object.keys(data).length === 0) return this.toView(current);

    // El "antes" se copia ANTES del update: comparar contra `current` después de
    // escribir depende de que nadie más tenga esa referencia, y eso no se
    // sostiene.
    const before = {
      tenantId: current.tenantId,
      targetUrl: current.targetUrl,
      active: current.active,
    };

    const updated = await this.prisma.qrCode.update({
      where: { id: current.id },
      data,
    });

    const scope = before.tenantId ? 'tenant' : 'platform';
    // Un cambio de destino y un apagón son cosas distintas para quien audita:
    // el primero es rutina, el segundo deja QR impresos sin servicio.
    if (updated.targetUrl !== before.targetUrl) {
      await this.audit(
        actorUserId,
        `${scope}.qr.target_updated`,
        current.id,
        { tenantId: before.tenantId, targetUrl: before.targetUrl },
        { tenantId: before.tenantId, targetUrl: updated.targetUrl },
      );
    }
    if (updated.active !== before.active) {
      await this.audit(
        actorUserId,
        `${scope}.qr.${updated.active ? 'enabled' : 'disabled'}`,
        current.id,
        { tenantId: before.tenantId, active: before.active },
        { tenantId: before.tenantId, active: updated.active },
      );
    }

    return this.toView(updated);
  }

  private async rotateCode(
    current: QrCode,
    name: string,
    reason: string,
    actorUserId: string,
  ): Promise<QrCodeView> {
    let lastError: unknown;
    // El código viejo es el dato que importa de esta operación: es el que quedó
    // impreso y el que alguien va a reclamar. Se copia antes de pisarlo.
    const before = { tenantId: current.tenantId, code: current.code };

    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      try {
        const updated = await this.prisma.qrCode.update({
          where: { id: current.id },
          data: { code: buildQrCode(name) },
        });

        await this.audit(
          actorUserId,
          `${before.tenantId ? 'tenant' : 'platform'}.qr.revoked`,
          current.id,
          { tenantId: before.tenantId, code: before.code },
          { tenantId: before.tenantId, code: updated.code, reason },
        );

        return this.toView(updated);
      } catch (err) {
        if (!isUniqueViolation(err, 'code')) throw err;
        lastError = err;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error('No se pudo generar un código único');
  }

  /**
   * Inserta reintentando ante choque de código.
   *
   * Un P2002 sobre `(scopeId, type)` significa que otra petición se adelantó:
   * se relee y se devuelve ESA, que es la respuesta correcta para un POST que
   * debe ser idempotente. Sobre `code`, que el dado salió repetido: se tira de
   * nuevo.
   */
  private async createWithUniqueCode(input: {
    name: string;
    type: QrCodeType;
    scopeId: string;
    tenantId: string | null;
    branchId?: string | null;
    targetUrl: string | null;
  }): Promise<QrCode> {
    for (let attempt = 0; attempt < CODE_COLLISION_RETRIES; attempt += 1) {
      try {
        return await this.prisma.qrCode.create({
          data: {
            code: buildQrCode(input.name),
            type: input.type,
            scopeId: input.scopeId,
            tenantId: input.tenantId,
            branchId: input.branchId ?? null,
            targetUrl: input.targetUrl,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err, 'code')) continue;
        if (isUniqueViolation(err)) {
          const winner = await this.prisma.qrCode.findUnique({
            where: {
              scopeId_type: { scopeId: input.scopeId, type: input.type },
            },
          });
          if (winner) return winner;
        }
        throw err;
      }
    }
    throw new Error('No se pudo generar un código único');
  }

  private findPlatformQr(): Promise<QrCode | null> {
    return this.prisma.qrCode.findUnique({
      where: {
        scopeId_type: { scopeId: PLATFORM_SCOPE, type: QrCodeType.PLATFORM },
      },
    });
  }

  private async requireQr(scopeId: string, type: QrCodeType): Promise<QrCode> {
    const qr = await this.prisma.qrCode.findUnique({
      where: { scopeId_type: { scopeId, type } },
    });
    if (!qr) {
      throw new NotFoundException({
        code: 'QR_NOT_FOUND',
        message: 'Este negocio todavía no tiene un QR permanente.',
      });
    }
    return qr;
  }

  private async requireTenant(tenantId: string): Promise<{ name: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { name: true },
    });
    if (!tenant) throw new NotFoundException('Tenant no encontrado');
    return tenant;
  }

  private validTarget(targetUrl: string): string {
    try {
      return assertValidQrTarget(targetUrl);
    } catch (err) {
      throw new BadRequestException(
        err instanceof Error ? err.message : 'Destino inválido',
      );
    }
  }

  /**
   * A dónde apuntaría el QR si se generara ahora.
   *
   * El orden es el de "qué le sirve al cliente que escanea": el sitio publicado
   * primero; la carta si es restaurante; y si no hay nada publicado, el borrador
   * del sitio, porque para cuando impriman las tarjetas ya estará vivo y el
   * código NO habrá cambiado.
   */
  private async suggestTargetFor(tenantId: string): Promise<string> {
    const [sites, menu] = await Promise.all([
      this.prisma.publicSite.findMany({
        where: { tenantId },
        select: { slug: true, publishedSlug: true, status: true },
        orderBy: { updatedAt: 'desc' },
      }),
      this.prisma.menuPublicConfig.findUnique({
        where: { tenantId },
        select: { slug: true, isPublished: true },
      }),
    ]);

    const published = sites.find(
      (site) => site.status === 'published' && site.publishedSlug,
    );
    if (published?.publishedSlug) return `/sites/${published.publishedSlug}`;
    if (menu?.isPublished) return `/menu/${menu.slug}`;
    if (sites[0]) return `/sites/${sites[0].publishedSlug ?? sites[0].slug}`;
    if (menu) return `/menu/${menu.slug}`;

    // Sin presencia pública todavía: la landing es mejor que un 404, y el
    // superadmin cambia el destino después sin reimprimir nada.
    return '/';
  }

  /**
   * Marca de la tarjeta, leída del sitio público del negocio.
   *
   * No se duplica en `Tenant` ni en `QrCode`: el día que el cliente cambie su
   * logo en el editor del sitio, la tarjeta tiene que cambiar con él.
   */
  private async brandingOf(
    tenantId: string,
    tenantName: string,
  ): Promise<QrBrandingView> {
    const site = await this.prisma.publicSite.findFirst({
      where: { tenantId },
      select: {
        shortName: true,
        city: true,
        seoDescription: true,
        themeLogoUrl: true,
        themePrimary: true,
        themeAccent: true,
        status: true,
        updatedAt: true,
      },
      // El publicado manda sobre el borrador: es lo que el cliente ya enseña.
      // (`published` > `draft` alfabéticamente, así que `desc` lo pone primero.)
      orderBy: [{ status: 'desc' }, { updatedAt: 'desc' }],
    });

    return {
      businessName: site?.shortName?.trim() || tenantName,
      logoUrl: site?.themeLogoUrl ?? null,
      primaryColor: site?.themePrimary ?? LYNKO_PRIMARY,
      accentColor: site?.themeAccent ?? LYNKO_ACCENT,
      city: site?.city ?? null,
      defaultSubtitle: site?.seoDescription ?? null,
      defaultCta: DEFAULT_CTA,
    };
  }

  private lynkoBranding(): QrBrandingView {
    return {
      businessName: 'Lynko',
      logoUrl: null,
      primaryColor: LYNKO_PRIMARY,
      accentColor: LYNKO_ACCENT,
      city: null,
      defaultSubtitle: 'El sistema para tu negocio',
      defaultCta: 'Escanea y conoce Lynko',
    };
  }

  private toView(qr: QrCode): QrCodeView {
    const baseUrl = this.baseUrl();
    return {
      id: qr.id,
      code: qr.code,
      type: qr.type,
      tenantId: qr.tenantId,
      branchId: qr.branchId,
      targetUrl: qr.targetUrl,
      resolvedTargetUrl: qr.targetUrl
        ? resolveQrTarget(qr.targetUrl, baseUrl)
        : null,
      scanUrl: buildQrScanUrl(qr.code, baseUrl),
      active: qr.active,
      card: {
        title: qr.cardTitle,
        subtitle: qr.cardSubtitle,
        cta: qr.cardCta,
      },
      createdAt: qr.createdAt.toISOString(),
      updatedAt: qr.updatedAt.toISOString(),
    };
  }

  private baseUrl(): string {
    return (
      process.env.PUBLIC_APP_URL?.replace(/\/+$/, '') || 'https://uselynko.com'
    );
  }

  /**
   * Misma bitácora que el resto del backoffice (`PlatformAuditLog`), con el
   * formato de acción que ya usan las demás mutaciones (`tenant.status`, …).
   * Como allá: si la auditoría falla NO tumba la operación.
   */
  private async audit(
    actorUserId: string,
    action: string,
    qrId: string,
    before: unknown,
    after: unknown,
  ): Promise<void> {
    try {
      await this.prisma.platformAuditLog.create({
        data: {
          actorUserId,
          action,
          targetType: 'qr_code',
          targetId: qrId,
          before: toJson(before),
          after: toJson(after),
        },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Audit log failed action=${action} qr=${qrId}: ${msg}`);
    }
  }
}

/**
 * Quita de `paymentInfo` lo que no debe salir en una página pública.
 *
 * Lista de exclusión y no de inclusión a propósito: el día que alguien agregue
 * un medio de pago nuevo al JSON, que aparezca en la escarapela es lo correcto
 * —para eso lo cargó—; lo que no puede pasar es que un dato personal se
 * publique por olvidar agregarlo a una lista blanca.
 */
function stripPrivateFields(info: Prisma.JsonValue): Prisma.JsonValue {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return info;
  const copy: Record<string, unknown> = { ...(info as Record<string, unknown>) };
  for (const field of PRIVATE_PAYMENT_FIELDS) delete copy[field];
  return copy as Prisma.JsonValue;
}

/** ¿La sede tiene con qué cobrar? Espeja `hasPaymentMethods()` del front. */
function hasAnyPaymentData(info: Prisma.JsonValue): boolean {
  if (!info || typeof info !== 'object' || Array.isArray(info)) return false;
  const data = info as Record<string, unknown>;
  const filled = (key: string) =>
    typeof data[key] === 'string' && (data[key] as string).trim().length > 0;

  return (
    filled('brebKey') ||
    filled('nequiPhone') ||
    filled('daviplataPhone') ||
    filled('accountNumber') ||
    filled('qrImageUrl') ||
    filled('qrPdfUrl') ||
    (Array.isArray(data.wallets) && data.wallets.length > 0)
  );
}

function trimOrNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? {})) as Prisma.InputJsonValue;
}

/** P2002 = choque de índice único. `field` acota a cuál. */
function isUniqueViolation(err: unknown, field?: string): boolean {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return false;
  if (err.code !== 'P2002') return false;
  if (!field) return true;
  const target = err.meta?.target;
  const fields = Array.isArray(target) ? target : [String(target ?? '')];
  return fields.some((name) => String(name).includes(field));
}
