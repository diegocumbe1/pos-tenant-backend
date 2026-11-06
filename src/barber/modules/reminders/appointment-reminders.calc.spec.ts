import {
  dueReminders,
  normalizeOffsets,
  offsetPhrase,
  ruleFor,
  type ReminderItem,
  type ReminderRecipient,
  type ReminderRule,
} from './appointment-reminders.calc';
import {
  AGENDA_REMINDER_TYPE,
  wantsNotification,
} from '../../../notifications/notification-rules';
import { NOTIFICATION_EVENT_ROLES } from '../../../notifications/notification-events.config';

const start = new Date('2026-11-05T20:00:00Z');
const before = (minutes: number) =>
  new Date(start.getTime() - minutes * 60_000);

const item: ReminderItem = {
  key: 'apt:1',
  branchId: 'b1',
  scheduledAt: start,
  staffUserId: 'ana',
};
const owner: ReminderRecipient = {
  id: 'dueno',
  roleCode: 'OWNER',
  branchIds: [],
};
const ana: ReminderRecipient = {
  id: 'ana',
  roleCode: 'CASHIER',
  branchIds: ['b1'],
};
const luis: ReminderRecipient = {
  id: 'luis',
  roleCode: 'CASHIER',
  branchIds: ['b1'],
};
const lejos: ReminderRecipient = {
  id: 'lejos',
  roleCode: 'CASHIER',
  branchIds: ['b2'],
};
const role = (
  roleCode: string,
  offsetsMinutes: number[],
  scope = 'ALL',
): ReminderRule => ({
  roleCode,
  userId: null,
  offsetsMinutes,
  scope,
});

describe('recordatorios de agenda', () => {
  it('avisa a la hora de cada aviso, y no antes', () => {
    const rules = [role('OWNER', [1440, 60])];
    expect(dueReminders([item], [owner], rules, before(61))).toEqual([]);
    expect(dueReminders([item], [owner], rules, before(60))).toEqual([
      {
        itemKey: 'apt:1',
        userId: 'dueno',
        minutesBefore: 60,
        scheduledAt: start,
      },
    ]);
    expect(
      dueReminders([item], [owner], rules, before(1440))[0].minutesBefore,
    ).toBe(1440);
  });

  it('pasada la ventana ya no sale: ni por caída del servidor ni por cita creada tarde', () => {
    expect(
      dueReminders([item], [owner], [role('OWNER', [60])], before(49)),
    ).toEqual([]);
  });

  it('"en 5 minutos" no sale con la cita empezada; "a la hora" sí', () => {
    const after = new Date(start.getTime() + 60_000);
    expect(dueReminders([item], [owner], [role('OWNER', [5])], after)).toEqual(
      [],
    );
    expect(
      dueReminders([item], [owner], [role('OWNER', [0])], after),
    ).toHaveLength(1);
  });

  it('sin regla no se le avisa a nadie', () => {
    expect(dueReminders([item], [owner, ana], [], before(60))).toEqual([]);
  });

  it('la regla personal manda sobre la del rol, y vacía silencia', () => {
    const rules: ReminderRule[] = [
      role('CASHIER', [60]),
      { roleCode: null, userId: 'ana', offsetsMinutes: [], scope: 'ALL' },
    ];
    expect(ruleFor(ana, rules)?.userId).toBe('ana');
    const due = dueReminders([item], [ana, luis], rules, before(60));
    expect(due.map((d) => d.userId)).toEqual(['luis']);
  });

  it('"solo las mías" filtra por quien atiende', () => {
    const rules = [role('CASHIER', [60], 'MINE')];
    const due = dueReminders([item], [ana, luis], rules, before(60));
    expect(due.map((d) => d.userId)).toEqual(['ana']);
  });

  it('respeta la sede, salvo para el dueño', () => {
    const rules = [role('CASHIER', [60]), role('OWNER', [60])];
    const due = dueReminders([item], [lejos, owner], rules, before(60));
    expect(due.map((d) => d.userId)).toEqual(['dueno']);
  });

  describe('elegir qué recibir', () => {
    const custom = (filters: object, offsets = [60]): ReminderRule => ({
      roleCode: 'OWNER',
      userId: null,
      offsetsMinutes: offsets,
      scope: 'ALL',
      mode: 'CUSTOM',
      filters,
    });
    const withContext: ReminderItem = {
      ...item,
      context: {
        staffId: 's1',
        staffRoleCode: 'CASHIER',
        serviceId: 'corte',
        cases: ['APPOINTMENT', 'PENDING'],
      },
    };
    const gets = (rule: ReminderRule) =>
      dueReminders([withContext], [owner], [rule], before(60)).length > 0;

    it('"ninguna" silencia aunque tenga avisos', () => {
      expect(gets({ ...role('OWNER', [60]), mode: 'NONE' })).toBe(false);
    });

    it('"todas" ignora los filtros', () => {
      expect(
        gets({
          ...role('OWNER', [60]),
          mode: 'ALL',
          filters: { serviceIds: ['otro'] },
        }),
      ).toBe(true);
    });

    it('sin el tipo elegido no llega el recordatorio', () => {
      expect(gets(custom({ types: ['barber.appointment.requested'] }))).toBe(
        false,
      );
      expect(gets(custom({ types: ['barber.appointment.reminder'] }))).toBe(
        true,
      );
    });

    it('por servicio', () => {
      expect(gets(custom({ serviceIds: ['corte'] }))).toBe(true);
      expect(gets(custom({ serviceIds: ['barba'] }))).toBe(false);
    });

    it('por caso', () => {
      expect(gets(custom({ cases: ['PENDING'] }))).toBe(true);
      expect(gets(custom({ cases: ['CLASS'] }))).toBe(false);
    });

    it('especialista y rol de quien atiende suman', () => {
      expect(
        gets(custom({ staffIds: ['otra'], staffRoleCodes: ['CASHIER'] })),
      ).toBe(true);
      expect(
        gets(custom({ staffIds: ['s1'], staffRoleCodes: ['KITCHEN'] })),
      ).toBe(true);
      expect(gets(custom({ staffIds: ['otra'] }))).toBe(false);
    });

    it('quién, servicio y caso se cumplen a la vez', () => {
      expect(gets(custom({ staffIds: ['s1'], serviceIds: ['barba'] }))).toBe(
        false,
      );
    });
  });

  describe('lo que decide el dueño', () => {
    const personal = { ...role('X', [10]), roleCode: null, userId: 'ana' };
    it('un rol bloqueado manda sobre lo personal', () => {
      const locked = { ...role('CASHIER', [60]), locked: true };
      expect(ruleFor(ana, [locked, personal])?.roleCode).toBe('CASHIER');
    });
    it('lo fijado a una persona manda sobre el rol bloqueado', () => {
      const locked = { ...role('CASHIER', [60]), locked: true };
      expect(
        ruleFor(ana, [locked, { ...personal, locked: true }])?.userId,
      ).toBe('ana');
    });
    it('sin bloqueo, manda lo personal', () => {
      expect(ruleFor(ana, [role('CASHIER', [60]), personal])?.userId).toBe(
        'ana',
      );
    });
  });

  it('dice el tiempo en palabras', () => {
    expect(offsetPhrase(0)).toBe('ahora');
    expect(offsetPhrase(30)).toBe('en 30 minutos');
    expect(offsetPhrase(60)).toBe('en 1 hora');
    expect(offsetPhrase(120)).toBe('en 2 horas');
    expect(offsetPhrase(1440)).toBe('en 1 día');
    expect(offsetPhrase(10080)).toBe('en 1 semana');
    expect(offsetPhrase(90)).toBe('en 90 minutos');
  });

  it('valida los avisos', () => {
    expect(normalizeOffsets([60, 1440, 60])).toEqual([1440, 60]);
    expect(() => normalizeOffsets([1, 2, 3, 4, 5, 6])).toThrow();
    expect(() => normalizeOffsets([50000])).toThrow();
    expect(() => normalizeOffsets([-5])).toThrow();
  });
});

describe('eventos de agenda', () => {
  const subject = { id: 'u', roleCode: 'CASHIER' };
  const type = 'barber.appointment.requested';

  it('sin regla decide el mapa de roles', () => {
    expect(wantsNotification(subject, null, type, null, true)).toBe(true);
    expect(wantsNotification(subject, null, type, null, false)).toBe(false);
  });

  it('los avisos de pago arrancan apagados hasta que alguien los active', () => {
    for (const payment of [
      'retail.payment.due',
      'retail.payment.missed',
      'barber.payment.due',
      'barber.payment.missed',
    ]) {
      expect(NOTIFICATION_EVENT_ROLES[payment]).toBeUndefined();
      const owner = { id: 'd', roleCode: 'OWNER' };
      const byDefault = !!NOTIFICATION_EVENT_ROLES[payment]?.includes('OWNER');
      expect(wantsNotification(owner, null, payment, null, byDefault)).toBe(
        false,
      );
      const on = {
        roleCode: 'OWNER',
        userId: null,
        scope: 'ALL',
        mode: 'CUSTOM',
        filters: { types: [payment] },
      };
      expect(wantsNotification(owner, on, payment, null, byDefault)).toBe(true);
    }
  });

  it('un rol fuera del mapa puede pedirlo', () => {
    const rule = {
      roleCode: 'CASHIER',
      userId: null,
      scope: 'ALL',
      mode: 'CUSTOM',
      filters: { types: [type] },
    };
    expect(wantsNotification(subject, rule, type, null, false)).toBe(true);
  });

  it('un aviso sin contexto no se filtra, pero respeta el tipo', () => {
    const rule = {
      roleCode: 'CASHIER',
      userId: null,
      scope: 'MINE',
      mode: 'CUSTOM',
      filters: { types: ['barber.signup.received'], serviceIds: ['corte'] },
    };
    expect(
      wantsNotification(subject, rule, 'barber.signup.received', null, true),
    ).toBe(true);
    expect(wantsNotification(subject, rule, type, null, true)).toBe(false);
  });
});

describe('entrenador', () => {
  const trainer = { id: 'carlos', roleCode: 'TRAINER' };
  const permissive = {
    roleCode: null,
    userId: 'carlos',
    offsetsMinutes: [60],
    scope: 'ALL',
    mode: 'ALL',
    filters: null,
    locked: false,
  };

  it('recibe el recordatorio de su clase', () => {
    expect(
      wantsNotification(trainer, permissive, AGENDA_REMINDER_TYPE, { staffUserId: 'carlos' }, true),
    ).toBe(true);
  });

  it('no recibe el de la clase de otro aunque su regla diga todas', () => {
    expect(
      wantsNotification(trainer, permissive, AGENDA_REMINDER_TYPE, { staffUserId: 'andrea' }, true),
    ).toBe(false);
    expect(wantsNotification(trainer, permissive, AGENDA_REMINDER_TYPE, null, true)).toBe(false);
  });

  it('no recibe avisos de pagos ni inscripciones', () => {
    for (const type of ['barber.payment.due', 'barber.payment.missed', 'barber.signup.received']) {
      expect(wantsNotification(trainer, permissive, type, { staffUserId: 'carlos' }, true)).toBe(false);
      expect(wantsNotification(trainer, permissive, type, null, true)).toBe(false);
    }
  });

  it('a los demás roles no les cambia nada', () => {
    expect(wantsNotification({ id: 'ana', roleCode: 'OWNER' }, permissive, 'barber.payment.due', null, true)).toBe(true);
  });
});
