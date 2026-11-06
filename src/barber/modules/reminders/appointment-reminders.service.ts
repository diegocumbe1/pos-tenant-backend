import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { TRAINER_ROLE_CODE } from '../../../auth/trainer-role';
import { TenantContext } from '../../../auth/types/tenant-context.interface';
import { calendarDayCO, formatDateTimeCO } from '../../../common/date.util';
import { NotificationDispatcherService } from '../../../notifications/notification-dispatcher.service';
import { PrismaService } from '../../../prisma/prisma.service';
import {
  dueReminders,
  MAX_REMINDER_MINUTES,
  normalizeOffsets,
  offsetPhrase,
  REMINDER_GRACE_MS,
  type ReminderItem,
} from './appointment-reminders.calc';
import { PauseNotificationsDto, UpsertReminderRuleDto } from './dto';
import { NOTIFICATION_EVENT_ROLES } from '../../../notifications/notification-events.config';
import {
  AGENDA_PERMISSION,
  AGENDA_REMINDER_TYPE,
  NOTIFICATION_CATALOG,
  ruleFor,
  type NotificationCase,
  type NotificationVertical,
} from '../../../notifications/notification-rules';

const TICK_MS = 60_000;
const CLEANUP_EVERY_TICKS = 60;
const KEEP_DELIVERIES_MS = 40 * 24 * 60 * 60 * 1000;
/** Lo que ya no va a pasar no se recuerda. */
const CLOSED_STATUSES = [
  'CANCELLED',
  'cancelled',
  'CANCELED',
  'canceled',
  'COMPLETED',
  'completed',
  'Completed',
  'NO_SHOW',
  'no_show',
  'REJECTED',
  'rejected',
];

/** Cómo llama a una cita cada modo de agenda. */
const WORD_BY_MODE: Record<string, string> = {
  resources: 'Reserva',
  fitness: 'Sesión',
};

interface DueDetail {
  title: string;
  body: string;
  url: string;
  branchId: string;
  payload: Record<string, unknown>;
}

/**
 * Recordatorios antes de una cita, como los de Google Calendar. Docs:
 * docs/PLAN_RECORDATORIOS_AGENDA.md
 *
 * Es el primer proceso del backend que corre por reloj. Se mantiene sin cola: un
 * `setInterval` en la instancia, y la tabla de entregas se encarga de que un
 * reinicio o una segunda instancia no repitan el aviso.
 */
@Injectable()
export class AppointmentRemindersService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(AppointmentRemindersService.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private ticks = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcherService,
  ) {}

  onModuleInit() {
    if (process.env.APPOINTMENT_REMINDERS_ENABLED === 'false') return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // ─── Configuración ─────────────────────────────────────────────────────────

  /** Dueño, administrador, y el super-admin en modo soporte definen lo del equipo. */
  private canManage(ctx: TenantContext) {
    return (
      ctx.isRoot ||
      !!ctx.supportSessionId ||
      ctx.roleCode === 'OWNER' ||
      ctx.roleCode === 'ADMIN'
    );
  }

  private assertManage(ctx: TenantContext) {
    if (!this.canManage(ctx)) {
      throw new ForbiddenException(
        'Solo el dueño o el administrador pueden definir los avisos del equipo',
      );
    }
  }

  private ruleData(ctx: TenantContext, dto: UpsertReminderRuleDto) {
    let offsetsMinutes: number[];
    try {
      offsetsMinutes = normalizeOffsets(dto.offsetsMinutes);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return {
      offsetsMinutes,
      scope: dto.scope ?? 'ALL',
      mode: dto.mode ?? 'ALL',
      filters: { ...(dto.filters ?? {}) },
      // Bloquear es del dueño: lo que mande cualquier otro se ignora.
      locked: this.canManage(ctx) && dto.locked === true,
      updatedById: ctx.userId,
    };
  }

  private async verticalOf(ctx: TenantContext): Promise<NotificationVertical> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: ctx.tenantId },
      select: { vertical: { select: { code: true } } },
    });
    return tenant?.vertical?.code === 'retail' ? 'retail' : 'barber';
  }

  /** Qué avisos recibe un rol si nadie lo ha decidido. */
  private defaultTypes(types: string[], roleCode: string) {
    return types.filter((type) =>
      NOTIFICATION_EVENT_ROLES[type]?.includes(roleCode),
    );
  }

  async overview(ctx: TenantContext) {
    const canManage = this.canManage(ctx);
    const tenantId = ctx.tenantId;
    const vertical = await this.verticalOf(ctx);
    const catalog = NOTIFICATION_CATALOG[vertical];
    const withPermission = {
      rolePermissions: { some: { permission: { code: catalog.permission } } },
    };
    const isAgenda = vertical === 'barber';
    const [rules, roles, staff, services, pause] = await Promise.all([
      this.prisma.appointmentReminderRule.findMany({ where: { tenantId } }),
      this.prisma.role.findMany({
        where: { tenantId, ...withPermission },
        orderBy: { name: 'asc' },
        select: { code: true, name: true },
      }),
      isAgenda
        ? this.prisma.barberStaff.findMany({
            where: { tenantId, isActive: true },
            orderBy: { name: 'asc' },
            select: { id: true, name: true },
          })
        : [],
      isAgenda
        ? this.prisma.barberService.findMany({
            where: { tenantId, isActive: true },
            orderBy: { name: 'asc' },
            select: { id: true, name: true },
          })
        : [],
      this.prisma.notificationPause.findUnique({
        where: { userId: ctx.userId },
      }),
    ]);
    const users = canManage
      ? await this.prisma.user.findMany({
          where: { tenantId, isActive: true },
          orderBy: { name: 'asc' },
          select: {
            id: true,
            name: true,
            role: {
              select: {
                code: true,
                name: true,
                rolePermissions: {
                  where: { permission: { code: catalog.permission } },
                  select: { roleId: true },
                },
              },
            },
          },
        })
      : [];
    // El super-admin en soporte no es parte del equipo: no recibe avisos.
    const receives = !ctx.supportSessionId && !ctx.isRoot;
    const pick = (rule: (typeof rules)[number] | undefined | null) =>
      rule
        ? {
            offsetsMinutes: rule.offsetsMinutes,
            scope: rule.scope,
            mode: rule.mode,
            filters: rule.filters ?? {},
            locked: rule.locked,
          }
        : null;
    const pausedUntil =
      pause && pause.pausedUntil > new Date()
        ? pause.pausedUntil.toISOString()
        : null;
    const roleRule = rules.find((r) => r.roleCode === ctx.roleCode);
    const ownRule = rules.find((r) => r.userId === ctx.userId);
    const effective = ruleFor(
      { id: ctx.userId, roleCode: ctx.roleCode },
      rules,
    );

    return {
      vertical,
      types:
        ctx.roleCode === TRAINER_ROLE_CODE
          ? [AGENDA_REMINDER_TYPE]
          : catalog.types,
      canManage,
      maxMinutes: MAX_REMINDER_MINUTES,
      me: receives
        ? {
            own: pick(ownRule),
            fromRole: pick(roleRule),
            defaultTypes: this.defaultTypes(catalog.types, ctx.roleCode),
            pausedUntil,
            // El dueño define lo suyo: a él no se le bloquea nada.
            locked: !canManage && !!effective?.locked,
          }
        : null,
      roles: canManage
        ? roles.map((role) => ({
            code: role.code,
            name: role.name,
            rule: pick(rules.find((r) => r.roleCode === role.code)),
            defaultTypes: this.defaultTypes(catalog.types, role.code),
          }))
        : [],
      people: users.map((user) => ({
        id: user.id,
        name: user.name,
        roleCode: user.role.code,
        roleName: user.role.name,
        /** Sin el permiso de esta pantalla no le llega nada, elija lo que elija. */
        hasAccess: user.role.rolePermissions.length > 0,
        rule: pick(rules.find((r) => r.userId === user.id)),
        defaultTypes: this.defaultTypes(catalog.types, user.role.code),
      })),
      // El entrenador no filtra: solo le llegan sus clases.
      options:
        ctx.roleCode === TRAINER_ROLE_CODE
          ? { roles: [], staff: [], services: [] }
          : {
              roles: roles.map((r) => ({ id: r.code, name: r.name })),
              staff,
              services,
            },
    };
  }

  private async assertNotLocked(ctx: TenantContext) {
    if (this.canManage(ctx)) return;
    const rules = await this.prisma.appointmentReminderRule.findMany({
      where: {
        tenantId: ctx.tenantId,
        OR: [{ userId: ctx.userId }, { roleCode: ctx.roleCode }],
      },
    });
    const rule = ruleFor({ id: ctx.userId, roleCode: ctx.roleCode }, rules);
    if (rule?.locked) {
      throw new ForbiddenException(
        'Estos avisos los definió el dueño: pídele que los cambie',
      );
    }
  }

  async saveMine(ctx: TenantContext, dto: UpsertReminderRuleDto) {
    await this.assertNotLocked(ctx);
    const data = this.ruleData(ctx, dto);
    await this.prisma.appointmentReminderRule.upsert({
      where: {
        tenantId_userId: { tenantId: ctx.tenantId, userId: ctx.userId },
      },
      create: { tenantId: ctx.tenantId, userId: ctx.userId, ...data },
      update: data,
    });
    return this.overview(ctx);
  }

  /** Vuelve a lo que se definió para su rol. */
  async resetMine(ctx: TenantContext) {
    await this.assertNotLocked(ctx);
    await this.prisma.appointmentReminderRule.deleteMany({
      where: { tenantId: ctx.tenantId, userId: ctx.userId },
    });
    return this.overview(ctx);
  }

  async pause(ctx: TenantContext, dto: PauseNotificationsDto) {
    await this.assertNotLocked(ctx);
    const pausedUntil = new Date(dto.until);
    if (pausedUntil <= new Date()) {
      throw new BadRequestException('Elige un momento que no haya pasado');
    }
    await this.prisma.notificationPause.upsert({
      where: { userId: ctx.userId },
      create: { tenantId: ctx.tenantId, userId: ctx.userId, pausedUntil },
      update: { pausedUntil },
    });
    return this.overview(ctx);
  }

  async resume(ctx: TenantContext) {
    await this.prisma.notificationPause.deleteMany({
      where: { userId: ctx.userId },
    });
    return this.overview(ctx);
  }

  private async assertTeamMember(ctx: TenantContext, userId: string) {
    this.assertManage(ctx);
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!user) throw new NotFoundException('Esa persona no es de tu equipo');
  }

  /** Lo que el dueño define para una persona concreta. */
  async saveUser(
    ctx: TenantContext,
    userId: string,
    dto: UpsertReminderRuleDto,
  ) {
    await this.assertTeamMember(ctx, userId);
    const data = this.ruleData(ctx, dto);
    await this.prisma.appointmentReminderRule.upsert({
      where: { tenantId_userId: { tenantId: ctx.tenantId, userId } },
      create: { tenantId: ctx.tenantId, userId, ...data },
      update: data,
    });
    return this.overview(ctx);
  }

  async resetUser(ctx: TenantContext, userId: string) {
    await this.assertTeamMember(ctx, userId);
    await this.prisma.appointmentReminderRule.deleteMany({
      where: { tenantId: ctx.tenantId, userId },
    });
    return this.overview(ctx);
  }

  async saveRole(
    ctx: TenantContext,
    roleCode: string,
    dto: UpsertReminderRuleDto,
  ) {
    this.assertManage(ctx);
    const role = await this.prisma.role.findFirst({
      where: {
        tenantId: ctx.tenantId,
        code: roleCode,
        rolePermissions: {
          some: {
            permission: {
              code: NOTIFICATION_CATALOG[await this.verticalOf(ctx)].permission,
            },
          },
        },
      },
      select: { id: true },
    });
    if (!role) {
      throw new NotFoundException('Ese rol no tiene acceso a esta pantalla');
    }
    const data = this.ruleData(ctx, dto);
    await this.prisma.appointmentReminderRule.upsert({
      where: { tenantId_roleCode: { tenantId: ctx.tenantId, roleCode } },
      create: { tenantId: ctx.tenantId, roleCode, ...data },
      update: data,
    });
    return this.overview(ctx);
  }

  // ─── El reloj ──────────────────────────────────────────────────────────────

  /** Nunca lanza: un recordatorio fallido no puede tumbar el proceso. */
  async tick(now = new Date()) {
    if (this.running) return;
    this.running = true;
    try {
      const rules = await this.prisma.appointmentReminderRule.findMany({
        where: { tenant: { status: 'ACTIVE' } },
      });
      const tenants = new Set(
        rules.filter((r) => r.offsetsMinutes.length).map((r) => r.tenantId),
      );
      for (const tenantId of tenants) {
        await this.runTenant(
          tenantId,
          rules.filter((r) => r.tenantId === tenantId),
          now,
        );
      }
      this.ticks += 1;
      if (this.ticks % CLEANUP_EVERY_TICKS === 0) {
        await this.prisma.appointmentReminderDelivery.deleteMany({
          where: {
            createdAt: { lt: new Date(now.getTime() - KEEP_DELIVERIES_MS) },
          },
        });
      }
    } catch (error) {
      this.logger.error(
        `Recordatorios: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private casesOf(apt: {
    classSessionId: string | null;
    status: string;
    source: string;
  }): NotificationCase[] {
    const cases: NotificationCase[] = [
      apt.classSessionId ? 'CLASS' : 'APPOINTMENT',
    ];
    if (apt.status.toUpperCase() === 'PENDING') cases.push('PENDING');
    if (apt.source === 'public') cases.push('ONLINE');
    return cases;
  }

  private async runTenant(
    tenantId: string,
    rules: Parameters<typeof dueReminders>[2],
    now: Date,
  ) {
    const maxOffset = Math.max(0, ...rules.flatMap((r) => r.offsetsMinutes));
    const appointments = await this.prisma.barberAppointment.findMany({
      where: {
        tenantId,
        status: { notIn: CLOSED_STATUSES },
        scheduledAt: {
          gte: new Date(now.getTime() - REMINDER_GRACE_MS),
          lte: new Date(now.getTime() + maxOffset * 60_000),
        },
      },
      select: {
        id: true,
        branchId: true,
        scheduledAt: true,
        classSessionId: true,
        status: true,
        source: true,
        serviceId: true,
        staffId: true,
        customer: { select: { name: true } },
        service: { select: { name: true } },
        staff: { select: { name: true, userId: true } },
      },
    });
    if (!appointments.length) return;

    // El rol de quien atiende, para quien filtra por rol.
    const staffUserIds = [
      ...new Set(
        appointments.flatMap((a) => (a.staff?.userId ? [a.staff.userId] : [])),
      ),
    ];
    const staffUsers = await this.prisma.user.findMany({
      where: { id: { in: staffUserIds } },
      select: { id: true, role: { select: { code: true } } },
    });
    const roleByUser = new Map(staffUsers.map((u) => [u.id, u.role.code]));

    // Una clase avisa una vez, no una por inscrito.
    const items = new Map<string, ReminderItem>();
    const details = new Map<string, Omit<DueDetail, 'title'>>();
    const attendees = new Map<string, number>();
    for (const apt of appointments) {
      const key = apt.classSessionId
        ? `class:${apt.classSessionId}`
        : `apt:${apt.id}`;
      attendees.set(key, (attendees.get(key) ?? 0) + 1);
      if (items.has(key)) continue;
      items.set(key, {
        key,
        branchId: apt.branchId,
        scheduledAt: apt.scheduledAt,
        staffUserId: apt.staff?.userId ?? null,
        context: {
          staffId: apt.staffId,
          staffRoleCode: apt.staff?.userId
            ? (roleByUser.get(apt.staff.userId) ?? null)
            : null,
          serviceId: apt.serviceId,
          cases: this.casesOf(apt),
        },
      });
      const day = calendarDayCO(apt.scheduledAt);
      const link = `/agenda/appointments?date=${day}&branch=${apt.branchId}`;
      details.set(key, {
        branchId: apt.branchId,
        url: apt.classSessionId ? link : `${link}&apt=${apt.id}`,
        body: [
          apt.service.name,
          apt.classSessionId ? null : apt.customer.name,
          formatDateTimeCO(apt.scheduledAt),
          apt.staff?.name,
        ]
          .filter(Boolean)
          .join(' · '),
        payload: apt.classSessionId
          ? { classSessionId: apt.classSessionId }
          : { appointmentId: apt.id },
      });
    }

    // Solo quien hoy puede ver la agenda: quitarle el permiso a un rol apaga sus
    // avisos aunque la regla siga guardada.
    const users = await this.prisma.user.findMany({
      where: {
        tenantId,
        isActive: true,
        role: {
          rolePermissions: {
            some: { permission: { code: AGENDA_PERMISSION } },
          },
        },
      },
      select: {
        id: true,
        role: { select: { code: true } },
        userBranches: { select: { branchId: true } },
      },
    });
    const due = dueReminders(
      [...items.values()],
      users.map((u) => ({
        id: u.id,
        roleCode: u.role.code,
        branchIds: u.userBranches.map((b) => b.branchId),
      })),
      rules,
      now,
    );
    if (!due.length) return;

    const settings = await this.prisma.barberSettings.findFirst({
      where: { tenantId },
      select: { bookingMode: true },
    });
    const word = WORD_BY_MODE[settings?.bookingMode ?? ''] ?? 'Cita';

    for (const reminder of due) {
      // Se reclama antes de enviar: mejor un aviso perdido que uno repetido.
      const { count } =
        await this.prisma.appointmentReminderDelivery.createMany({
          data: [{ tenantId, ...reminder }],
          skipDuplicates: true,
        });
      if (!count) continue;
      const detail = details.get(reminder.itemKey);
      if (!detail) continue;
      const isClass = reminder.itemKey.startsWith('class:');
      const people = attendees.get(reminder.itemKey) ?? 0;
      await this.notifications.dispatchToUsers(
        {
          tenantId,
          branchId: detail.branchId,
          vertical: 'barber',
          type: AGENDA_REMINDER_TYPE,
          title: `${isClass ? 'Clase' : word} ${offsetPhrase(reminder.minutesBefore)}`,
          body: isClass
            ? `${detail.body} · ${people} inscrito${people === 1 ? '' : 's'}`
            : detail.body,
          url: detail.url,
          payload: { ...detail.payload, minutesBefore: reminder.minutesBefore },
        },
        [reminder.userId],
      );
    }
  }
}
