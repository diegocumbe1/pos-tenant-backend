import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ensureRecurringHorizon } from '../../shared/recurring-horizon';
import {
  isWithinBusinessHours,
  resolveBusinessHours,
} from '../../shared/business-hours';
import { PrismaService } from '../../../prisma/prisma.service';
import { NotificationDispatcherService } from '../../../notifications/notification-dispatcher.service';
import { calendarDayCO, formatDateTimeCO } from '../../../common/date.util';
import { GoogleCalendarService } from '../integrations/google-calendar/google-calendar.service';
import {
  CreatePublicAppointmentDto,
  CreatePublicSignupDto,
  PublicAvailabilityQueryDto,
} from './dto/public-appointment.dto';

type BrochureSettings = Prisma.BarberSettingsGetPayload<{
  include: {
    tenant: { select: { id: true; name: true } };
    branch: { select: { id: true; name: true; address: true } };
  };
}>;

const DEFAULT_DAY_START_MIN = 9 * 60; // 09:00
const DEFAULT_DAY_END_MIN = 19 * 60; // 19:00
const SLOT_STEP_MIN = 30;

// ─── Inscripción web ─────────────────────────────────────────────────────────
const SIGNUP_TAG = 'Inscripción web';
const SIGNUP_START = '── Inscripción web ──';
const SIGNUP_END = '── /Inscripción web ──';

/** Lo que llenó en el formulario, como bloque de notas (se reemplaza entero). */
function signupNotesBlock(
  dto: CreatePublicSignupDto,
  serviceName: string | null,
): string {
  const g = dto.guardian;
  const lines = [
    `Inscrito: ${formatDateTimeCO(new Date())}`,
    serviceName ? `Le interesa: ${serviceName}` : null,
    dto.document ? `Documento: ${dto.document.trim()}` : null,
    dto.birthDate ? `Nacimiento: ${dto.birthDate}` : null,
    g
      ? `Acudiente: ${g.name.trim()}${g.relationship ? ` (${g.relationship.trim()})` : ''} · ${g.phone.trim()}${g.email ? ` · ${g.email}` : ''}`
      : null,
    dto.notes?.trim() ? `Comentario: ${dto.notes.trim()}` : null,
    dto.intake ? 'Ficha deportiva completa: ver "Ficha de inscripción".' : null,
  ].filter(Boolean);
  return [SIGNUP_START, ...lines, SIGNUP_END].join('\n');
}

const INTAKE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

/**
 * La ficha deportiva tal como se guarda en `BarberCustomer.intake`. La lee la
 * ficha del cliente (frontend: CustomerIntake). `version` por si cambia.
 */
function buildIntake(
  dto: CreatePublicSignupDto,
  serviceName: string | null,
): Prisma.InputJsonValue | null {
  const i = dto.intake;
  if (!i) return null;
  const clean = (v?: string) => v?.trim() || null;
  const yesNo = (v: { has: boolean; detail?: string }) => ({
    has: v.has,
    detail: v.has ? clean(v.detail) : null,
  });
  // Solo días conocidos y horas HH:MM, sin repetir y en orden.
  const availability: Record<string, string[]> = {};
  for (const day of INTAKE_DAYS) {
    const raw = i.availability?.[day];
    if (!Array.isArray(raw)) continue;
    const hours = [...new Set(raw.filter((h) => typeof h === 'string' && /^\d{2}:\d{2}$/.test(h)))]
      .sort()
      .slice(0, 24);
    if (hours.length > 0) availability[day] = hours;
  }
  const g = dto.guardian;
  return {
    version: 1,
    submittedAt: new Date().toISOString(),
    documentType: i.documentType ?? null,
    document: clean(dto.document),
    birthDate: dto.birthDate ?? null,
    sex: i.sex ?? null,
    city: clean(i.city),
    guardian: g
      ? {
          name: g.name.trim(),
          relationship: clean(g.relationship),
          phone: g.phone.trim(),
          email: clean(g.email),
        }
      : null,
    sport: clean(i.sport),
    sportLevel: i.sportLevel ?? null,
    club: clean(i.club),
    health: {
      disease: yesNo(i.health.disease),
      injury: yesNo(i.health.injury),
      discomfort: yesNo(i.health.discomfort),
      restrictions: i.health.restrictions.trim(),
    },
    goal: i.goal.trim(),
    availability,
    interest: clean(i.interest),
    serviceId: dto.serviceId ?? null,
    serviceName,
    consents: {
      truthful: true,
      dataPolicy: true,
      selfResponsibility: true,
      media: i.consents.media,
      acceptedAt: new Date().toISOString(),
    },
  };
}

function mergeSignupNotes(current: string | null, block: string): string {
  const text = current ?? '';
  const start = text.indexOf(SIGNUP_START);
  const end = text.indexOf(SIGNUP_END);
  if (start >= 0 && end > start) {
    return (
      text.slice(0, start) +
      block +
      text.slice(end + SIGNUP_END.length)
    ).trim();
  }
  return text.trim() ? `${text.trim()}\n\n${block}` : block;
}

/**
 * Los medios de pago que el negocio configuró para que sus clientes le paguen.
 * Sin las rutas internas de los archivos ni el documento del titular.
 */
function publicPaymentInfo(
  raw: Prisma.JsonValue | undefined,
): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const info = raw as Record<string, unknown>;
  const allowed = [
    'bankName',
    'accountType',
    'accountNumber',
    'accountHolder',
    'nequiPhone',
    'daviplataPhone',
    'brebKey',
    'brebKeyType',
    'wallets',
    'qrImageUrl',
    'qrPdfUrl',
    'qrProvider',
    'qrSourceType',
    'transferInstructions',
  ];
  const out = Object.fromEntries(
    allowed
      .filter((k) => info[k] != null && info[k] !== '')
      .map((k) => [k, info[k]]),
  );
  return Object.keys(out).length ? out : null;
}

@Injectable()
export class BarberPublicService {
  private readonly logger = new Logger(BarberPublicService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationDispatcherService,
    private readonly googleCalendar: GoogleCalendarService,
  ) {}

  async getProfile(slug: string) {
    const settings = await this.loadPublishedSettings(slug);
    return this.toProfileDto(settings);
  }

  async listServices(branchId: string) {
    await this.assertBranchPublished(branchId);
    const services = await this.prisma.barberService.findMany({
      // Solo lo que se agenda: un plan, un paquete o una clase grupal no se
      // reservan como cita (la clase tiene cupo y su propio horario).
      where: { branchId, isActive: true, kind: 'SERVICE' },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
    return services.map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description ?? '',
      durationMin: service.durationMin,
      priceCOP: service.priceCOP,
      color: service.color,
    }));
  }

  async listSpecialists(branchId: string, serviceId?: string) {
    await this.assertBranchPublished(branchId);
    const staff = await this.prisma.barberStaff.findMany({
      where: {
        branchId,
        isActive: true,
        ...(serviceId ? { services: { some: { serviceId } } } : {}),
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
      include: { services: { select: { serviceId: true } } },
    });
    return staff.map((member) => ({
      id: member.id,
      name: member.name,
      bio: member.bio ?? '',
      avatarUrl: member.avatarUrl,
      color: member.color,
      serviceIds: member.services.map((s) => s.serviceId),
    }));
  }

  // Horas ocupadas (sin datos personales) para que el sitio público calcule la
  // disponibilidad en el cliente respetando el horario del negocio. Sin auth.
  async getBusyRanges(branchId: string, query: PublicAvailabilityQueryDto) {
    await this.assertBranchPublished(branchId);
    // Las reservas fijas tienen que bloquear la cancha también en la web.
    await ensureRecurringHorizon(this.prisma, branchId);

    // Ventana amplia alrededor de la fecha para cubrir cualquier offset de zona
    // horaria; el cliente solo usa los rangos que solapan su día local.
    const base = this.parseDateBoundary(query.date, 0).getTime();
    const from = new Date(base - 12 * 60 * 60_000);
    const to = new Date(base + 36 * 60 * 60_000);

    const appointments = await this.prisma.barberAppointment.findMany({
      where: {
        branchId,
        ...(query.specialistId
          ? { staffId: query.specialistId }
          : query.serviceId
            ? { serviceId: query.serviceId }
            : {}),
        status: { notIn: ['CANCELLED', 'REJECTED'] },
        scheduledAt: { lt: to },
        scheduledEnd: { gt: from },
      },
      select: { scheduledAt: true, scheduledEnd: true },
      orderBy: { scheduledAt: 'asc' },
    });
    // Lo que el especialista tiene en su Google personal, sin título.
    const google = query.specialistId
      ? await this.googleCalendar.busyForStaff(
          branchId,
          query.specialistId,
          from,
          to,
        )
      : [];

    return {
      ranges: [
        ...appointments.map((a) => ({
          startTime: a.scheduledAt.toISOString(),
          endTime: a.scheduledEnd.toISOString(),
        })),
        ...google.map((g) => ({
          startTime: g.start.toISOString(),
          endTime: g.end.toISOString(),
        })),
      ],
    };
  }

  async getAvailability(branchId: string, query: PublicAvailabilityQueryDto) {
    await this.assertBranchPublished(branchId);
    // Las reservas fijas tienen que bloquear la cancha también en la web.
    await ensureRecurringHorizon(this.prisma, branchId);

    // El especialista es opcional: sin él se calcula la disponibilidad del
    // recurso/espacio (servicio), que debe venir en la query.
    if (query.specialistId) {
      const staff = await this.prisma.barberStaff.findUnique({
        where: { id: query.specialistId },
        select: { id: true, branchId: true, isActive: true },
      });
      if (!staff || staff.branchId !== branchId || !staff.isActive) {
        throw new NotFoundException('Specialist not found');
      }
    } else if (!query.serviceId) {
      throw new BadRequestException(
        'serviceId is required when no specialist is selected',
      );
    }

    const durationMinutes = await this.resolveDuration(
      query.serviceId,
      query.durationMinutes,
      branchId,
    );

    const dayStart = this.parseDateBoundary(query.date, 0);
    const dayEnd = this.parseDateBoundary(query.date, 24 * 60);

    const appointments = await this.prisma.barberAppointment.findMany({
      where: {
        branchId,
        ...(query.specialistId
          ? { staffId: query.specialistId }
          : { serviceId: query.serviceId }),
        status: { notIn: ['CANCELLED', 'REJECTED'] },
        scheduledAt: { lt: dayEnd },
        scheduledEnd: { gt: dayStart },
      },
      select: { scheduledAt: true, scheduledEnd: true },
    });
    if (query.specialistId) {
      const google = await this.googleCalendar.busyForStaff(
        branchId,
        query.specialistId,
        dayStart,
        dayEnd,
      );
      appointments.push(
        ...google.map((g) => ({ scheduledAt: g.start, scheduledEnd: g.end })),
      );
    }

    const slots: string[] = [];
    const now = Date.now();
    for (
      let minute = DEFAULT_DAY_START_MIN;
      minute + durationMinutes <= DEFAULT_DAY_END_MIN;
      minute += SLOT_STEP_MIN
    ) {
      const slotStart = this.parseDateBoundary(query.date, minute);
      const slotEnd = new Date(slotStart.getTime() + durationMinutes * 60_000);
      if (slotStart.getTime() <= now) continue;
      const overlaps = appointments.some(
        (apt) => apt.scheduledAt < slotEnd && apt.scheduledEnd > slotStart,
      );
      if (!overlaps) slots.push(slotStart.toISOString());
    }

    return {
      date: query.date,
      specialistId: query.specialistId,
      durationMinutes,
      slots,
    };
  }

  async createAppointment(branchId: string, dto: CreatePublicAppointmentDto) {
    await ensureRecurringHorizon(this.prisma, branchId);
    const settings = await this.prisma.barberSettings.findUnique({
      where: { branchId },
      select: {
        tenantId: true,
        branchId: true,
        publicProfilePublished: true,
        onlineBookingEnabled: true,
        businessHours: true,
      },
    });
    if (!settings || !settings.publicProfilePublished) {
      throw new NotFoundException('Branch not found');
    }
    if (!settings.onlineBookingEnabled) {
      throw new ForbiddenException({
        code: 'ONLINE_BOOKING_DISABLED',
        message: 'Online booking is disabled for this branch',
      });
    }

    const service = await this.prisma.barberService.findUnique({
      where: { id: dto.serviceId },
      select: {
        id: true,
        branchId: true,
        isActive: true,
        durationMin: true,
        kind: true,
      },
    });
    if (
      !service ||
      service.branchId !== branchId ||
      !service.isActive ||
      service.kind !== 'SERVICE'
    ) {
      throw new BadRequestException('Service is not available');
    }

    // El especialista es opcional: en modo recursos se reserva el espacio
    // (servicio) sin asignar persona.
    let staff: { id: string } | null = null;
    if (dto.specialistId) {
      const found = await this.prisma.barberStaff.findUnique({
        where: { id: dto.specialistId },
        select: {
          id: true,
          branchId: true,
          isActive: true,
          services: { select: { serviceId: true } },
        },
      });
      if (!found || found.branchId !== branchId || !found.isActive) {
        throw new BadRequestException('Specialist is not available');
      }
      if (
        found.services.length > 0 &&
        !found.services.some((s) => s.serviceId === service.id)
      ) {
        throw new BadRequestException(
          'Specialist does not offer the requested service',
        );
      }
      staff = { id: found.id };
    }

    const scheduledAt = new Date(dto.scheduledAt);
    if (Number.isNaN(scheduledAt.getTime())) {
      throw new BadRequestException('Invalid scheduledAt');
    }
    if (scheduledAt.getTime() <= Date.now()) {
      throw new BadRequestException('scheduledAt must be in the future');
    }
    const durationMin = dto.durationMinutes ?? service.durationMin;
    const scheduledEnd = new Date(scheduledAt.getTime() + durationMin * 60_000);

    // El sitio solo ofrece horas dentro del horario; esto cierra la puerta a
    // quien llame a la API directo. El equipo sí puede agendar fuera de horario.
    if (
      !isWithinBusinessHours(
        resolveBusinessHours(settings.businessHours),
        scheduledAt,
        scheduledEnd,
      )
    ) {
      throw new BadRequestException({
        code: 'OUTSIDE_BUSINESS_HOURS',
        message: 'Esa hora está fuera del horario de atención',
      });
    }

    // Con especialista: conflicto por persona. Sin especialista (recurso):
    // conflicto por el propio servicio/espacio para no doble-reservarlo.
    const conflict = await this.prisma.barberAppointment.findFirst({
      where: {
        branchId,
        ...(staff ? { staffId: staff.id } : { serviceId: service.id }),
        status: { notIn: ['CANCELLED', 'REJECTED'] },
        scheduledAt: { lt: scheduledEnd },
        scheduledEnd: { gt: scheduledAt },
      },
      select: { id: true },
    });
    const googleBusy = staff
      ? await this.googleCalendar.busyForStaff(
          branchId,
          staff.id,
          scheduledAt,
          scheduledEnd,
        )
      : [];
    if (
      conflict ||
      googleBusy.some((g) => g.start < scheduledEnd && g.end > scheduledAt)
    ) {
      throw new ConflictException({
        code: 'SLOT_TAKEN',
        message: 'The requested time slot is no longer available',
      });
    }

    const customer = await this.upsertCustomer(
      branchId,
      settings.tenantId,
      dto,
    );

    const appointment = await this.prisma.barberAppointment.create({
      data: {
        tenantId: settings.tenantId,
        branchId,
        customerId: customer.id,
        serviceId: service.id,
        staffId: staff?.id ?? null,
        scheduledAt,
        scheduledEnd,
        source: 'public',
        // Las reservas públicas entran pendientes de aprobación del negocio.
        status: 'PENDING',
        notes: dto.notes,
      },
      include: { service: true, staff: true },
    });

    // Aviso al equipo por push, no por WhatsApp: la reserva entra pendiente y
    // alguien tiene que aprobarla. Tocar la notificación abre la agenda en ese
    // día con la cita seleccionada. Best-effort: nunca tumba la reserva.
    void this.notifications
      .dispatch({
        tenantId: settings.tenantId,
        branchId,
        vertical: 'barber',
        type: 'barber.appointment.requested',
        title: 'Nueva reserva por aprobar',
        body: [
          customer.name,
          appointment.service.name,
          formatDateTimeCO(appointment.scheduledAt),
          appointment.staff?.name,
        ]
          .filter(Boolean)
          .join(' · '),
        url: `/barber/appointments?date=${calendarDayCO(appointment.scheduledAt)}&apt=${appointment.id}`,
        payload: { appointmentId: appointment.id },
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Appointment notification dispatch failed: ${message}`,
        );
      });

    return {
      id: appointment.id,
      status: appointment.status,
      scheduledAt: appointment.scheduledAt,
      scheduledEnd: appointment.scheduledEnd,
      service: {
        id: appointment.service.id,
        name: appointment.service.name,
        durationMin: appointment.service.durationMin,
        priceCOP: appointment.service.priceCOP,
      },
      specialist: appointment.staff
        ? { id: appointment.staff.id, name: appointment.staff.name }
        : null,
      customer: {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
      },
    };
  }

  /**
   * Inscripción desde el sitio público, para negocios sin agenda (gimnasio).
   * Deja al cliente registrado con su acudiente, avisa al equipo por push y
   * devuelve cómo pagar. No crea cita ni cobro: el plan lo vende la recepción.
   *
   * Si el teléfono ya existe, NO se renombra al cliente (cualquiera puede
   * escribir cualquier número): solo se pone al día el bloque de inscripción
   * en sus notas.
   */
  async createSignup(branchId: string, dto: CreatePublicSignupDto) {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { branchId },
      select: { tenantId: true, publicProfilePublished: true },
    });
    if (!settings || !settings.publicProfilePublished) {
      throw new NotFoundException('Branch not found');
    }
    const service = dto.serviceId
      ? await this.prisma.barberService.findFirst({
          where: { id: dto.serviceId, branchId, isActive: true },
          select: { id: true, name: true, priceCOP: true },
        })
      : null;

    const block = signupNotesBlock(dto, service?.name ?? null);
    // La última ficha que mandó reemplaza la anterior, igual que el bloque de
    // notas. Sin ficha (formulario básico) no se toca la que tenga.
    const intake = buildIntake(dto, service?.name ?? null);
    const phone = dto.phone.trim();
    const name = dto.name.trim().replace(/\s+/g, ' ');
    const existing = await this.prisma.barberCustomer.findUnique({
      where: { branchId_phone: { branchId, phone } },
    });
    const customer = existing
      ? await this.prisma.barberCustomer.update({
          where: { id: existing.id },
          data: {
            email: existing.email ?? dto.email ?? null,
            notes: mergeSignupNotes(existing.notes, block),
            ...(intake ? { intake } : {}),
            tags: existing.tags.includes(SIGNUP_TAG)
              ? existing.tags
              : [...existing.tags, SIGNUP_TAG],
          },
        })
      : await this.prisma.barberCustomer.create({
          data: {
            tenantId: settings.tenantId,
            branchId,
            name,
            phone,
            email: dto.email ?? null,
            notes: block,
            tags: [SIGNUP_TAG],
            ...(intake ? { intake } : {}),
          },
        });

    void this.notifications
      .dispatch({
        tenantId: settings.tenantId,
        branchId,
        vertical: 'barber',
        type: 'barber.signup.received',
        title: existing
          ? 'Inscripción de un cliente que ya existía'
          : 'Nueva inscripción desde el sitio',
        body: [
          name,
          service?.name,
          dto.guardian ? `Acudiente: ${dto.guardian.name}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
        url: '/barber/customers',
        payload: { customerId: customer.id },
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Signup notification dispatch failed: ${message}`);
      });

    const branch = await this.prisma.branch.findUnique({
      where: { id: branchId },
      select: { paymentInfo: true },
    });
    return {
      customerId: customer.id,
      name: customer.name,
      service: service
        ? { id: service.id, name: service.name, priceCOP: service.priceCOP }
        : null,
      paymentInfo: publicPaymentInfo(branch?.paymentInfo),
    };
  }

  private async upsertCustomer(
    branchId: string,
    tenantId: string,
    dto: CreatePublicAppointmentDto,
  ) {
    const normalizedPhone = dto.customerPhone.trim();
    const existing = await this.prisma.barberCustomer.findUnique({
      where: { branchId_phone: { branchId, phone: normalizedPhone } },
    });
    if (existing) {
      if (
        existing.name !== dto.customerName ||
        (dto.customerEmail && existing.email !== dto.customerEmail)
      ) {
        return this.prisma.barberCustomer.update({
          where: { id: existing.id },
          data: {
            name: dto.customerName,
            email: dto.customerEmail ?? existing.email,
          },
        });
      }
      return existing;
    }
    return this.prisma.barberCustomer.create({
      data: {
        tenantId,
        branchId,
        name: dto.customerName,
        phone: normalizedPhone,
        email: dto.customerEmail,
      },
    });
  }

  private async loadPublishedSettings(slug: string): Promise<BrochureSettings> {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { bookingSlug: slug },
      include: {
        tenant: { select: { id: true, name: true } },
        branch: { select: { id: true, name: true, address: true } },
      },
    });
    if (!settings || !settings.publicProfilePublished) {
      throw new NotFoundException(`Profile ${slug} not found`);
    }
    return settings;
  }

  private async assertBranchPublished(branchId: string) {
    const settings = await this.prisma.barberSettings.findUnique({
      where: { branchId },
      select: { publicProfilePublished: true },
    });
    if (!settings || !settings.publicProfilePublished) {
      throw new NotFoundException('Branch not found');
    }
  }

  private async resolveDuration(
    serviceId: string | undefined,
    fallback: number | undefined,
    branchId: string,
  ): Promise<number> {
    if (serviceId) {
      const service = await this.prisma.barberService.findUnique({
        where: { id: serviceId },
        select: { branchId: true, durationMin: true, isActive: true },
      });
      if (!service || service.branchId !== branchId || !service.isActive) {
        throw new BadRequestException('Service is not available');
      }
      return service.durationMin;
    }
    if (fallback && fallback > 0) return fallback;
    return 30;
  }

  private parseDateBoundary(date: string, minutesFromMidnight: number): Date {
    const [yearStr, monthStr, dayStr] = date.split('-');
    const year = Number(yearStr);
    const month = Number(monthStr);
    const day = Number(dayStr);
    if (!year || !month || !day) {
      throw new BadRequestException('Invalid date');
    }
    // Constructor local: con TZ=America/Bogota el proceso interpreta esto como
    // hora Colombia (un slot "08:00" es 08:00 Bogotá, no 08:00 UTC).
    return new Date(year, month - 1, day, 0, minutesFromMidnight, 0, 0);
  }

  private toProfileDto(settings: BrochureSettings) {
    const stats = this.coerceJsonArray(settings.stats, ['label', 'value']);
    const gallery = this.coerceJsonArray(settings.galleryImages, [
      'title',
      'imageUrl',
    ]);

    return {
      tenantId: settings.tenantId,
      branchId: settings.branchId,
      slug: settings.bookingSlug,
      name: settings.tenant?.name ?? settings.branch?.name ?? '',
      shortName: settings.shortName ?? '',
      tagline: settings.tagline ?? '',
      description: settings.description ?? '',
      eyebrow: settings.eyebrow ?? '',
      address: settings.branch?.address ?? '',
      neighborhood: settings.neighborhood ?? '',
      city: settings.city ?? '',
      phone: settings.phone ?? '',
      whatsapp: settings.whatsapp ?? '',
      heroImageUrl: settings.heroImageUrl ?? settings.themeBannerImageUrl ?? '',
      logoUrl: settings.themeLogoImageUrl ?? settings.logoUrl ?? '',
      theme: {
        primary: settings.themePrimaryColor,
        accent: settings.themeAccentColor,
        ink: settings.themeInkColor,
      },
      stats,
      highlights: settings.highlights ?? [],
      gallery,
      socials: {
        instagram: settings.socialInstagram ?? '',
        facebook: settings.socialFacebook ?? '',
        tiktok: settings.socialTiktok ?? '',
        website: settings.socialWebsite ?? '',
      },
      instagram: {
        profileUrl: settings.instagramProfileUrl ?? '',
        posts: settings.instagramPosts ?? [],
      },
      onlineBookingEnabled: settings.onlineBookingEnabled,
    };
  }

  private coerceJsonArray<K extends string>(
    raw: Prisma.JsonValue,
    fields: K[],
  ): Array<Record<K, string>> {
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((entry): entry is Record<K, string> => {
        if (!entry || typeof entry !== 'object') return false;
        const record = entry as Record<string, unknown>;
        return fields.every((field) => typeof record[field] === 'string');
      })
      .map((entry) => {
        const out = {} as Record<K, string>;
        for (const field of fields) {
          out[field] = entry[field];
        }
        return out;
      });
  }
}
