import {
  billingAlertFor,
  billingAlertText,
  billingDatesOf,
  billingGroupText,
} from './billing-alert-rules';

const dates = { dueDay: '2026-11-10', graceDay: '2026-11-15' };

describe('billingAlertFor', () => {
  it.each([
    ['2026-11-07', null],
    ['2026-11-08', 'billing.due_soon'],
    ['2026-11-09', 'billing.due_soon'],
    ['2026-11-10', 'billing.due'],
    ['2026-11-14', 'billing.due'],
    ['2026-11-15', 'billing.grace_ended'],
    ['2026-12-20', 'billing.grace_ended'],
  ])('el %s', (today, type) => {
    expect(billingAlertFor(today, dates)).toBe(type);
  });
});

describe('billingDatesOf', () => {
  const base = {
    status: 'ACTIVE',
    trialEndsAt: null,
    nextPaymentDueAt: new Date('2026-11-10T17:00:00Z'),
    currentPeriodEnd: new Date('2026-10-01T17:00:00Z'),
    graceEndsAt: null,
  };

  it('el vencimiento es la próxima fecha de pago, con 5 días de gracia', () => {
    expect(billingDatesOf(base)).toEqual(dates);
  });

  it('sin fecha de pago usa el fin del periodo', () => {
    expect(billingDatesOf({ ...base, nextPaymentDueAt: null }).dueDay).toBe(
      '2026-10-01',
    );
  });

  it('una prueba vence el día que termina', () => {
    const trial = {
      ...base,
      status: 'TRIALING',
      trialEndsAt: new Date('2026-11-20T17:00:00Z'),
    };
    expect(billingDatesOf(trial)).toEqual({
      dueDay: '2026-11-20',
      graceDay: '2026-11-25',
    });
  });

  it('usa la gracia guardada si es válida', () => {
    const sub = { ...base, graceEndsAt: new Date('2026-11-13T17:00:00Z') };
    expect(billingDatesOf(sub).graceDay).toBe('2026-11-13');
  });

  it('ignora una gracia anterior al vencimiento', () => {
    const sub = { ...base, graceEndsAt: new Date('2026-10-05T17:00:00Z') };
    expect(billingDatesOf(sub).graceDay).toBe('2026-11-15');
  });

  it('usa el día de Colombia: las 8 p. m. no son el día siguiente', () => {
    const sub = { ...base, nextPaymentDueAt: new Date('2026-11-11T01:00:00Z') };
    expect(billingDatesOf(sub).dueDay).toBe('2026-11-10');
  });
});

describe('textos', () => {
  it('2 días antes', () => {
    expect(
      billingAlertText(
        'billing.due_soon',
        'Malexca',
        '2026-11-08',
        '2026-11-10',
      ).title,
    ).toBe('Vence en 2 días: Malexca');
  });

  it('el día del vencimiento', () => {
    expect(
      billingAlertText('billing.due', 'Malexca', '2026-11-10', '2026-11-10')
        .title,
    ).toBe('Vence hoy: Malexca');
  });

  it('a los 5 días deja claro que no se bloquea sola', () => {
    const { title, body } = billingAlertText(
      'billing.grace_ended',
      'Malexca',
      '2026-11-15',
      '2026-11-10',
    );
    expect(title).toBe('Revisar bloqueo: Malexca');
    expect(body).toContain('5 días');
    expect(body).toContain('no la bloquea sola');
  });

  it('varias cuentas salen en un solo aviso', () => {
    expect(billingGroupText('billing.due', ['A', 'B', 'C', 'D', 'E'])).toEqual({
      title: '5 cuentas vencidas sin pago',
      body: 'A, B, C y 2 más.',
    });
  });
});
