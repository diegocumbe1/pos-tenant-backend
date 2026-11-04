/**
 * Quién quiere qué aviso. Sin base de datos, para que los recordatorios y los
 * eventos de la agenda decidan exactamente igual.
 * Docs: docs/PLAN_RECORDATORIOS_AGENDA.md
 */
export const AGENDA_PERMISSION = 'barber:appointments:read';
export const AGENDA_REMINDER_TYPE = 'barber.appointment.reminder';

export type NotificationVertical = 'barber' | 'retail';

/**
 * Los avisos que cada quien puede elegir, por vertical, y el permiso sin el cual
 * no llegan: el aviso lleva a una pantalla que hay que poder abrir.
 */
export const NOTIFICATION_CATALOG: Record<
  NotificationVertical,
  { permission: string; types: string[] }
> = {
  barber: {
    permission: AGENDA_PERMISSION,
    types: [
      AGENDA_REMINDER_TYPE,
      'barber.appointment.requested',
      'barber.signup.received',
      'barber.payment.due',
      'barber.payment.missed',
    ],
  },
  retail: {
    permission: 'retail:sales:read',
    types: [
      'retail.sale.created',
      'retail.payment.due',
      'retail.payment.missed',
    ],
  },
};

export const ALL_RULE_TYPES = [
  ...NOTIFICATION_CATALOG.barber.types,
  ...NOTIFICATION_CATALOG.retail.types,
];

export function catalogForType(type: string) {
  if (NOTIFICATION_CATALOG.barber.types.includes(type)) {
    return NOTIFICATION_CATALOG.barber;
  }
  if (NOTIFICATION_CATALOG.retail.types.includes(type)) {
    return NOTIFICATION_CATALOG.retail;
  }
  return null;
}

export type NotificationCase = 'APPOINTMENT' | 'CLASS' | 'PENDING' | 'ONLINE';
export const NOTIFICATION_CASES: NotificationCase[] = [
  'APPOINTMENT',
  'CLASS',
  'PENDING',
  'ONLINE',
];

/** Una lista vacía o ausente significa "todos". */
export interface NotificationFilters {
  types?: string[];
  staffIds?: string[];
  staffRoleCodes?: string[];
  serviceIds?: string[];
  cases?: string[];
}

/** De qué trata un aviso. Un aviso sin contexto (inscripción) no se filtra. */
export interface NotificationContext {
  staffId?: string | null;
  staffUserId?: string | null;
  staffRoleCode?: string | null;
  serviceId?: string | null;
  cases?: NotificationCase[];
}

export interface NotificationRule {
  roleCode: string | null;
  userId: string | null;
  scope: string;
  /** 'ALL' | 'CUSTOM' | 'NONE'. Ausente = 'ALL'. */
  mode?: string;
  filters?: unknown;
  /** Lo decidió el dueño. Un rol bloqueado manda sobre lo personal. */
  locked?: boolean;
}

export interface RuleSubject {
  id: string;
  roleCode: string;
}

export function parseFilters(value: unknown): NotificationFilters {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as NotificationFilters)
    : {};
}

/**
 * La regla que le aplica a alguien: la suya, o la de su rol. Si el dueño bloqueó
 * el rol, lo personal no cuenta, salvo que también él lo haya fijado a esa persona.
 */
export function ruleFor<T extends NotificationRule>(
  subject: RuleSubject,
  rules: T[],
): T | null {
  const own = rules.find((r) => r.userId === subject.id);
  const role = rules.find((r) => r.roleCode === subject.roleCode);
  if (own && (own.locked || !role?.locked)) return own;
  return role ?? null;
}

const includes = (list: string[] | undefined, value?: string | null) =>
  !!value && !!list?.includes(value);

/**
 * Especialista y rol responden lo mismo —quién atiende—, así que elegir a Ana y
 * al rol Gerente suma. Quién, servicio y caso se tienen que cumplir a la vez.
 */
export function matchesFilters(
  filters: NotificationFilters,
  context: NotificationContext | null,
): boolean {
  if (!context) return true;
  const hasWho = !!filters.staffIds?.length || !!filters.staffRoleCodes?.length;
  if (
    hasWho &&
    !includes(filters.staffIds, context.staffId) &&
    !includes(filters.staffRoleCodes, context.staffRoleCode)
  ) {
    return false;
  }
  if (
    filters.serviceIds?.length &&
    !includes(filters.serviceIds, context.serviceId)
  ) {
    return false;
  }
  if (
    filters.cases?.length &&
    !context.cases?.some((c) => filters.cases?.includes(c))
  ) {
    return false;
  }
  return true;
}

/**
 * ¿Esta persona quiere este aviso? `byDefault` responde cuando nadie lo ha dicho:
 * sin regla, o con una regla que no eligió tipos.
 */
export function wantsNotification(
  subject: RuleSubject,
  rule: NotificationRule | null,
  type: string,
  context: NotificationContext | null,
  byDefault: boolean,
): boolean {
  if (!rule) return byDefault;
  const mode = rule.mode ?? 'ALL';
  if (mode === 'NONE') return false;
  if (rule.scope === 'MINE' && context && context.staffUserId !== subject.id) {
    return false;
  }
  if (mode === 'ALL') return true;
  const filters = parseFilters(rule.filters);
  const wantsType = filters.types ? filters.types.includes(type) : byDefault;
  return wantsType && matchesFilters(filters, context);
}
