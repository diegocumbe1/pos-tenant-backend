import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { GoogleCalendarConnection } from '@prisma/client';
import { createHash } from 'node:crypto';
import { TenantContext } from '../../../../auth/types/tenant-context.interface';
import {
  addCalendarDaysCO,
  calendarDayCO,
  dayEndCO,
  dayStartCO,
} from '../../../../common/date.util';
import {
  FeatureOverrides,
  resolveFeatureValue,
} from '../../../../platform/plans/plan-features';
import { PrismaService } from '../../../../prisma/prisma.service';
import { isCompletedStatus } from '../../../shared/appointment-status';
import { BarberTenantHelper } from '../../../shared/barber-tenant.helper';
import { BarberClassesService } from '../../classes/barber-classes.service';
import {
  GoogleApiError,
  GoogleEventBody,
  buildAuthUrl,
  createCalendar,
  deleteCalendar,
  deleteEvent,
  exchangeCode,
  googleConfigured,
  putEvent,
  queryFreeBusy,
  refreshAccessToken,
  revokeToken,
} from './google-calendar.client';
import {
  ConnectState,
  decryptToken,
  encryptToken,
  signState,
  verifyState,
} from './google-calendar.crypto';

// La ventana que se mantiene igual en Google. Lo de antes se deja como quedó.
const WINDOW_PAST_DAYS = 7;
const WINDOW_FUTURE_DAYS = 53; // listSessions acepta hasta 62 días de rango
const SYNC_DEBOUNCE_MS = 3_000;
const SOFT_SYNC_EVERY_MS = 5 * 60_000;
const BUSY_CACHE_MS = 60_000;
const CONNECT_LINK_DAYS = 7;
const GOOGLE_CONCURRENCY = 4;
const FREED = new Set(['CANCELLED', 'REJECTED']);

type Draft = {
  ref: string;
  staffId: string | null;
  startsAt: Date;
  endsAt: Date;
  summary: string;
  lines: string[];
  phone: string | null;
  link: string;
};

export type ConnectionDto = {
  id: string;
  googleEmail: string;
  connectedAt: Date;
  needsReauth: boolean;
  lastSyncedAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
  reminderMinutes: number[];
  includePhone: boolean;
};

function toDto(conn: GoogleCalendarConnection): ConnectionDto {
  return {
    id: conn.id,
    googleEmail: conn.googleEmail,
    connectedAt: conn.connectedAt,
    needsReauth: conn.needsReauth,
    lastSyncedAt: conn.lastSyncedAt,
    lastError: conn.lastError,
    lastErrorAt: conn.lastErrorAt,
    reminderMinutes: conn.reminderMinutes,
    includePhone: conn.includePhone,
  };
}

function appUrl(): string {
  return (process.env.PUBLIC_APP_URL || 'https://uselynko.com').replace(
    /\/+$/,
    '',
  );
}

/** Id del evento en Google: hex (válido en base32hex) y siempre el mismo. */
function eventIdFor(connectionId: string, ref: string): string {
  return createHash('sha256').update(`${connectionId}:${ref}`).digest('hex');
}

async function runPool<T>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(size, items.length) },
    async () => {
      while (next < items.length) await fn(items[next++]);
    },
  );
  await Promise.all(workers);
}

/**
 * Google Calendar de la agenda. LYNKO MANDA:
 *
 * - Lynko → Google: las citas y clases se escriben en un calendario aparte que
 *   crea Lynko. Se RECONCILIA (lo que debería estar vs. lo que hay), no se
 *   engancha cada camino que toca una cita: así ninguno queda por fuera.
 * - Google → Lynko: solo el ocupado del calendario principal, para no reservar
 *   encima de compromisos personales. Nunca se importan eventos.
 *
 * Google nunca tumba la agenda: si falla, la cita se guarda igual y el error
 * queda en la conexión. Ver docs/PLAN_GOOGLE_CALENDAR.md (frontend).
 */
@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);
  private readonly accessTokens = new Map<
    string,
    { token: string; expiresAt: number }
  >();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly running = new Map<string, Promise<unknown>>();
  private readonly rerun = new Set<string>();
  private readonly lastSoftSync = new Map<string, number>();
  private readonly busyCache = new Map<
    string,
    { at: number; ranges: { start: Date; end: Date }[] }
  >();

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantHelper: BarberTenantHelper,
    private readonly classes: BarberClassesService,
  ) {}

  // ─── Estado y conexión ─────────────────────────────────────────────────────

  async status(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    const [planAllows, connections, staff] = await Promise.all([
      this.planAllows(ctx.tenantId),
      this.prisma.googleCalendarConnection.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
      }),
      this.prisma.barberStaff.findMany({
        where: { tenantId: ctx.tenantId, branchId: ctx.branchId },
        select: { id: true, name: true, isActive: true, email: true },
        orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      }),
    ]);
    const byStaff = new Map(connections.map((c) => [c.staffId, c]));
    return {
      configured: googleConfigured(),
      planAllows,
      business: byStaff.has(null) ? toDto(byStaff.get(null)!) : null,
      staff: staff
        // Un inactivo solo aparece si quedó conectado: hay que poder soltarlo.
        .filter((s) => s.isActive || byStaff.has(s.id))
        .map((s) => ({
          staffId: s.id,
          name: s.name,
          email: s.email,
          isActive: s.isActive,
          connection: byStaff.has(s.id) ? toDto(byStaff.get(s.id)!) : null,
        })),
    };
  }

  /** URL de Google para conectar desde este mismo navegador (el dueño). */
  async connectUrl(ctx: TenantContext, staffId: string | null) {
    await this.assertCanConnect(ctx, staffId);
    const state = signState({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      staffId,
      returnTo: 'settings',
      exp: Date.now() + 15 * 60_000,
    });
    return { url: buildAuthUrl(state) };
  }

  /**
   * Enlace para mandarle al especialista: lo abre en su celular, entra con su
   * Google y queda conectado, sin necesitar usuario en Lynko.
   */
  async connectLink(ctx: TenantContext, staffId: string) {
    await this.assertCanConnect(ctx, staffId);
    const expiresAt = Date.now() + CONNECT_LINK_DAYS * 86_400_000;
    const token = signState({
      tenantId: ctx.tenantId,
      branchId: ctx.branchId,
      staffId,
      returnTo: 'page',
      exp: expiresAt,
    });
    // Hermano del callback: `.../google-calendar/callback` → `.../connect`.
    const url = new URL('connect', process.env.GOOGLE_CALENDAR_REDIRECT_URI);
    url.searchParams.set('token', token);
    return { url: url.toString(), expiresAt: new Date(expiresAt) };
  }

  /** Del enlace del especialista a Google. null = enlace vencido o alterado. */
  authUrlFromLink(token: string): string | null {
    return verifyState(token) ? buildAuthUrl(token) : null;
  }

  /**
   * Vuelta de Google. Guarda la conexión, crea el calendario "Lynko · …" y
   * escribe las citas. Devuelve a dónde mandar a la persona.
   */
  async handleCallback(
    code: string,
    stateToken: string,
  ): Promise<{
    state: ConnectState;
    businessName: string;
    staffName: string | null;
  }> {
    const state = verifyState(stateToken);
    if (!state) {
      throw new BadRequestException(
        'El enlace venció o no es válido. Pide uno nuevo.',
      );
    }
    const [tenant, staff] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: state.tenantId },
        select: { name: true },
      }),
      state.staffId
        ? this.prisma.barberStaff.findUnique({
            where: { id: state.staffId },
            select: { name: true, branchId: true },
          })
        : Promise.resolve(null),
    ]);
    if (!tenant || (state.staffId && staff?.branchId !== state.branchId)) {
      throw new NotFoundException('El negocio o el especialista ya no existe');
    }
    if (!(await this.planAllows(state.tenantId))) {
      throw new ForbiddenException(
        'El plan del negocio no incluye Google Calendar',
      );
    }

    const tokens = await exchangeCode(code);
    const scopeKey = state.staffId ?? `branch:${state.branchId}`;
    const previous = await this.prisma.googleCalendarConnection.findUnique({
      where: { scopeKey },
    });

    // Reconectar con la MISMA cuenta reutiliza su calendario: los eventos ya
    // están ahí. Con otra cuenta se arranca de cero y se suelta la anterior.
    let calendarId: string;
    if (previous && previous.googleEmail === tokens.email) {
      calendarId = previous.calendarId;
    } else {
      if (previous) await this.releaseGoogle(previous);
      calendarId = await createCalendar(
        tokens.accessToken,
        `Lynko · ${tenant.name}`,
      );
    }

    const data = {
      googleEmail: tokens.email,
      calendarId,
      refreshTokenEnc: encryptToken(tokens.refreshToken),
      needsReauth: false,
      lastError: null,
      lastErrorAt: null,
    };
    const conn = await this.prisma.googleCalendarConnection.upsert({
      where: { scopeKey },
      create: {
        tenantId: state.tenantId,
        branchId: state.branchId,
        staffId: state.staffId,
        scopeKey,
        ...data,
      },
      update: { ...data, connectedAt: new Date() },
    });
    if (previous && previous.calendarId !== calendarId) {
      await this.prisma.googleCalendarEventLink.deleteMany({
        where: { connectionId: conn.id },
      });
    }
    this.accessTokens.set(conn.id, {
      token: tokens.accessToken,
      expiresAt: Date.now() + tokens.expiresIn * 1000,
    });
    this.requestSync(state.branchId, 0);

    return {
      state,
      businessName: tenant.name,
      staffName: staff?.name ?? null,
    };
  }

  async updateConnection(
    ctx: TenantContext,
    id: string,
    patch: { reminderMinutes?: number[]; includePhone?: boolean },
  ) {
    await this.findScoped(ctx, id);
    const updated = await this.prisma.googleCalendarConnection.update({
      where: { id },
      data: {
        ...(patch.reminderMinutes
          ? {
              reminderMinutes: [...new Set(patch.reminderMinutes)].sort(
                (a, b) => b - a,
              ),
            }
          : {}),
        ...(patch.includePhone !== undefined
          ? { includePhone: patch.includePhone }
          : {}),
      },
    });
    // El contenido de los eventos cambió: el hash lo detecta y los reescribe.
    this.requestSync(ctx.branchId, 0);
    return toDto(updated);
  }

  /** Borra el calendario de Lynko en Google, revoca el permiso y suelta todo. */
  async disconnect(ctx: TenantContext, id: string) {
    const conn = await this.findScoped(ctx, id);
    await this.releaseGoogle(conn);
    await this.prisma.googleCalendarConnection.delete({ where: { id } });
    this.accessTokens.delete(id);
    return { ok: true };
  }

  async syncNow(ctx: TenantContext) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    if (!(await this.planAllows(ctx.tenantId))) {
      throw new ForbiddenException(
        'El plan del negocio no incluye Google Calendar',
      );
    }
    await this.runBranch(ctx.branchId);
    return this.status(ctx);
  }

  // ─── Disparo ───────────────────────────────────────────────────────────────

  /** Agenda una reconciliación de la sede; las ráfagas se agrupan en una. */
  requestSync(branchId: string, delayMs = SYNC_DEBOUNCE_MS) {
    clearTimeout(this.timers.get(branchId));
    this.timers.set(
      branchId,
      setTimeout(() => {
        this.timers.delete(branchId);
        void this.runBranch(branchId);
      }, delayMs),
    );
  }

  /**
   * Autocuración al abrir la agenda: recoge lo que se escapó (reservas fijas
   * generadas, una caída de Google). Como máximo cada 5 minutos por sede.
   */
  softSync(branchId: string) {
    const last = this.lastSoftSync.get(branchId) ?? 0;
    if (Date.now() - last < SOFT_SYNC_EVERY_MS) return;
    this.lastSoftSync.set(branchId, Date.now());
    this.requestSync(branchId, 0);
  }

  /** Una sola reconciliación a la vez por sede; si llega otra, corre después. */
  private runBranch(branchId: string): Promise<unknown> {
    const current = this.running.get(branchId);
    if (current) {
      this.rerun.add(branchId);
      return current;
    }
    const run = this.reconcileBranch(branchId)
      .catch((err: Error) =>
        this.logger.warn(`Reconciliación de ${branchId} falló: ${err.message}`),
      )
      .finally(() => {
        this.running.delete(branchId);
        if (this.rerun.delete(branchId)) this.requestSync(branchId, 0);
      });
    this.running.set(branchId, run);
    return run;
  }

  // ─── Lynko → Google ────────────────────────────────────────────────────────

  private async reconcileBranch(branchId: string) {
    const connections = await this.prisma.googleCalendarConnection.findMany({
      where: { branchId, needsReauth: false },
    });
    if (connections.length === 0) return;
    const tenantId = connections[0].tenantId;
    if (!googleConfigured() || !(await this.planAllows(tenantId))) return;

    const today = calendarDayCO(new Date());
    const fromDay = addCalendarDaysCO(today, -WINDOW_PAST_DAYS);
    const toDay = addCalendarDaysCO(today, WINDOW_FUTURE_DAYS);
    const window = { from: dayStartCO(fromDay), to: dayEndCO(toDay) };
    const drafts = await this.desiredEvents(tenantId, branchId, fromDay, toDay);

    for (const conn of connections) {
      await this.reconcileConnection(
        conn,
        conn.staffId
          ? drafts.filter((d) => d.staffId === conn.staffId)
          : drafts,
        window,
      );
    }
  }

  private async desiredEvents(
    tenantId: string,
    branchId: string,
    fromDay: string,
    toDay: string,
  ): Promise<Draft[]> {
    const [appointments, sessions, branch] = await Promise.all([
      this.prisma.barberAppointment.findMany({
        where: {
          branchId,
          // Los asistentes a una clase no van uno por uno: la clase es UN evento.
          classSessionId: null,
          scheduledAt: { gte: dayStartCO(fromDay), lte: dayEndCO(toDay) },
        },
        include: {
          customer: { select: { name: true, phone: true } },
          service: { select: { name: true } },
          staff: { select: { name: true } },
        },
      }),
      // Solo usa tenantId y branchId del contexto.
      this.classes.listSessions(
        { tenantId, branchId } as TenantContext,
        fromDay,
        toDay,
      ),
      this.prisma.branch.findUnique({
        where: { id: branchId },
        select: { address: true },
      }),
    ]);

    const drafts: Draft[] = [];
    for (const apt of appointments) {
      const status = apt.status.toUpperCase();
      if (FREED.has(status)) continue;
      const prefix =
        status === 'PENDING'
          ? '(Por aprobar) '
          : isCompletedStatus(status)
            ? '✓ '
            : '';
      drafts.push({
        ref: `appt:${apt.id}`,
        staffId: apt.staffId,
        startsAt: apt.scheduledAt,
        endsAt: apt.scheduledEnd,
        summary: `${prefix}${apt.service.name} · ${apt.customer.name}`,
        lines: [
          `Cliente: ${apt.customer.name}`,
          `Servicio: ${apt.service.name}`,
          apt.staff ? `Especialista: ${apt.staff.name}` : '',
          apt.notes ? `Notas: ${apt.notes}` : '',
        ].filter(Boolean),
        phone: apt.customer.phone,
        link: `${appUrl()}/barber/appointments?date=${calendarDayCO(apt.scheduledAt)}&apt=${apt.id}`,
      });
    }
    for (const s of sessions) {
      if (s.status.toUpperCase() === 'CANCELLED') continue;
      const going = s.bookedCount + s.expectedCount;
      drafts.push({
        // Estable aunque la clase pase de calculada a guardada.
        ref: s.scheduleId
          ? `class:${s.scheduleId}|${s.startsAt}`
          : `session:${s.sessionId}`,
        staffId: s.staffId,
        startsAt: new Date(s.startsAt),
        endsAt: new Date(s.endsAt),
        summary: `Clase: ${s.serviceName} · ${going}/${s.capacity}`,
        lines: [
          `Clase: ${s.serviceName}`,
          `Van ${going} de ${s.capacity} cupos` +
            (s.expectedCount
              ? ` (${s.expectedCount} con inscripción fija)`
              : ''),
          s.staffName ? `Entrenador: ${s.staffName}` : '',
        ].filter(Boolean),
        phone: null,
        link: `${appUrl()}/barber/classes?date=${calendarDayCO(new Date(s.startsAt))}`,
      });
    }
    return drafts.map((d) => ({
      ...d,
      lines: branch?.address
        ? [...d.lines, `Lugar: ${branch.address}`]
        : d.lines,
    }));
  }

  private buildBody(
    draft: Draft,
    conn: GoogleCalendarConnection,
  ): GoogleEventBody {
    const description = [
      ...draft.lines,
      conn.includePhone &&
      draft.phone &&
      !draft.phone.startsWith('sin-telefono')
        ? `Teléfono: ${draft.phone}`
        : '',
      '',
      `Ver en Lynko: ${draft.link}`,
      'Gestionado por Lynko: los cambios hechos aquí se reemplazan. Para mover o cancelar, hazlo en Lynko.',
    ]
      .filter((line, i, all) => line !== '' || all[i - 1] !== '')
      .join('\n');
    return {
      summary: draft.summary,
      description,
      start: {
        dateTime: draft.startsAt.toISOString(),
        timeZone: 'America/Bogota',
      },
      end: { dateTime: draft.endsAt.toISOString(), timeZone: 'America/Bogota' },
      reminders: {
        useDefault: false,
        overrides: conn.reminderMinutes.map((minutes) => ({
          method: 'popup' as const,
          minutes,
        })),
      },
      extendedProperties: { private: { lynkoRef: draft.ref } },
    };
  }

  private async reconcileConnection(
    conn: GoogleCalendarConnection,
    drafts: Draft[],
    window: { from: Date; to: Date },
  ) {
    let accessToken: string;
    try {
      accessToken = await this.accessToken(conn);
    } catch (err) {
      await this.recordError(conn.id, err);
      return;
    }

    const links = await this.prisma.googleCalendarEventLink.findMany({
      where: { connectionId: conn.id },
    });
    const linkByRef = new Map(links.map((l) => [l.ref, l]));
    const wanted = new Set(drafts.map((d) => d.ref));
    let firstError: unknown = null;

    await runPool(drafts, GOOGLE_CONCURRENCY, async (draft) => {
      const body = this.buildBody(draft, conn);
      const hash = createHash('sha256')
        .update(JSON.stringify(body))
        .digest('hex')
        .slice(0, 32);
      const link = linkByRef.get(draft.ref);
      if (link?.contentHash === hash) return;
      const googleEventId =
        link?.googleEventId ?? eventIdFor(conn.id, draft.ref);
      try {
        await putEvent(accessToken, conn.calendarId, googleEventId, body);
        await this.prisma.googleCalendarEventLink.upsert({
          where: {
            connectionId_ref: { connectionId: conn.id, ref: draft.ref },
          },
          create: {
            connectionId: conn.id,
            ref: draft.ref,
            googleEventId,
            contentHash: hash,
            startsAt: draft.startsAt,
          },
          update: { contentHash: hash, startsAt: draft.startsAt },
        });
      } catch (err) {
        firstError ??= err;
      }
    });

    // Lo enlazado dentro de la ventana que ya no debería estar: cancelada,
    // rechazada, borrada, movida a otro especialista o fuera de la ventana.
    const stale = links.filter(
      (l) =>
        !wanted.has(l.ref) &&
        l.startsAt >= window.from &&
        l.startsAt <= window.to,
    );
    await runPool(stale, GOOGLE_CONCURRENCY, async (link) => {
      try {
        await deleteEvent(accessToken, conn.calendarId, link.googleEventId);
        await this.prisma.googleCalendarEventLink.delete({
          where: { id: link.id },
        });
      } catch (err) {
        firstError ??= err;
      }
    });

    if (firstError) {
      await this.recordError(conn.id, firstError);
    } else {
      await this.prisma.googleCalendarConnection.update({
        where: { id: conn.id },
        data: { lastSyncedAt: new Date(), lastError: null, lastErrorAt: null },
      });
    }
  }

  // ─── Google → Lynko: ocupado ───────────────────────────────────────────────

  /**
   * Rangos ocupados del Google personal de un especialista. Si no está
   * conectado o Google falla, [] : la disponibilidad nunca se cae por Google.
   */
  async busyForStaff(
    branchId: string,
    staffId: string,
    from: Date,
    to: Date,
  ): Promise<{ start: Date; end: Date }[]> {
    const conn = await this.prisma.googleCalendarConnection.findUnique({
      where: { staffId },
    });
    if (!conn || conn.branchId !== branchId || conn.needsReauth) return [];
    if (!googleConfigured() || !(await this.planAllows(conn.tenantId)))
      return [];

    const key = `${conn.id}|${from.toISOString()}|${to.toISOString()}`;
    const cached = this.busyCache.get(key);
    if (cached && Date.now() - cached.at < BUSY_CACHE_MS) return cached.ranges;
    try {
      const ranges = await queryFreeBusy(
        await this.accessToken(conn),
        from,
        to,
      );
      if (this.busyCache.size > 500) this.busyCache.clear();
      this.busyCache.set(key, { at: Date.now(), ranges });
      return ranges;
    } catch (err) {
      await this.recordError(conn.id, err);
      return [];
    }
  }

  /** Para la agenda interna: el ocupado de cada especialista conectado. */
  async busyForBranch(ctx: TenantContext, fromDay: string, toDay: string) {
    if (toDay < fromDay || addCalendarDaysCO(fromDay, 14) < toDay) {
      throw new BadRequestException('Rango inválido (máximo 14 días)');
    }
    const connections = await this.prisma.googleCalendarConnection.findMany({
      where: {
        tenantId: ctx.tenantId,
        branchId: ctx.branchId,
        staffId: { not: null },
        needsReauth: false,
      },
      select: { staffId: true },
    });
    const from = dayStartCO(fromDay);
    const to = dayEndCO(toDay);
    const perStaff = await Promise.all(
      connections.map(async ({ staffId }) =>
        (await this.busyForStaff(ctx.branchId, staffId!, from, to)).map(
          (r) => ({
            staffId: staffId!,
            start: r.start.toISOString(),
            end: r.end.toISOString(),
          }),
        ),
      ),
    );
    return { ranges: perStaff.flat() };
  }

  // ─── Internos ──────────────────────────────────────────────────────────────

  private async planAllows(tenantId: string): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true, featureOverrides: true },
    });
    if (!tenant) return false;
    return Boolean(
      resolveFeatureValue(
        tenant.plan,
        'googleCalendarSync',
        tenant.featureOverrides as FeatureOverrides | null,
      ),
    );
  }

  private async assertCanConnect(ctx: TenantContext, staffId: string | null) {
    await this.tenantHelper.assertBarberTenant(ctx.tenantId);
    if (!googleConfigured()) {
      throw new ServiceUnavailableException(
        'Google Calendar no está configurado en el servidor',
      );
    }
    if (!(await this.planAllows(ctx.tenantId))) {
      throw new ForbiddenException(
        'Google Calendar está incluido en el plan Premium',
      );
    }
    if (staffId) {
      await this.tenantHelper.assertScopedRecord(
        'barberStaff',
        ctx,
        staffId,
        'Staff',
      );
    }
  }

  private async findScoped(ctx: TenantContext, id: string) {
    const conn = await this.prisma.googleCalendarConnection.findUnique({
      where: { id },
    });
    if (
      !conn ||
      conn.tenantId !== ctx.tenantId ||
      conn.branchId !== ctx.branchId
    ) {
      throw new NotFoundException('Conexión no encontrada');
    }
    return conn;
  }

  private async accessToken(conn: GoogleCalendarConnection): Promise<string> {
    const cached = this.accessTokens.get(conn.id);
    if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
    const res = await refreshAccessToken(decryptToken(conn.refreshTokenEnc));
    this.accessTokens.set(conn.id, {
      token: res.accessToken,
      expiresAt: Date.now() + res.expiresIn * 1000,
    });
    return res.accessToken;
  }

  /** Best-effort: si el token ya no sirve, igual se suelta en Lynko. */
  private async releaseGoogle(conn: GoogleCalendarConnection) {
    try {
      const token = await this.accessToken(conn);
      await deleteCalendar(token, conn.calendarId).catch(() => undefined);
      await revokeToken(decryptToken(conn.refreshTokenEnc)).catch(
        () => undefined,
      );
    } catch {
      // Token revocado desde Google: no hay nada que borrar con él.
    }
    this.accessTokens.delete(conn.id);
  }

  private async recordError(connectionId: string, err: unknown) {
    const needsReauth =
      err instanceof GoogleApiError &&
      (err.reason === 'invalid_grant' || err.status === 401);
    const message = err instanceof Error ? err.message : String(err);
    this.logger.warn(`Google Calendar ${connectionId}: ${message}`);
    if (needsReauth) this.accessTokens.delete(connectionId);
    await this.prisma.googleCalendarConnection
      .update({
        where: { id: connectionId },
        data: {
          lastError: needsReauth
            ? 'Google rechazó el permiso: hay que volver a conectar'
            : message.slice(0, 500),
          lastErrorAt: new Date(),
          ...(needsReauth ? { needsReauth: true } : {}),
        },
      })
      .catch(() => undefined);
  }
}
