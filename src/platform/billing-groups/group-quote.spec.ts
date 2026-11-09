import { quoteGroup, type GroupTenantInput } from './group-quote';

const due = new Date('2026-11-10T05:00:00Z');
const base = (over: Partial<GroupTenantInput>): GroupTenantInput => ({
  tenantId: 't',
  name: 'N',
  verticalCode: 'restaurant',
  planCode: 'PRO',
  priceUSD: 33,
  termBps: 0,
  lockedMonthlyCOP: null,
  dueAt: due,
  ...over,
});
const run = (tenants: GroupTenantInput[], termMonths = 1) =>
  quoteGroup({
    tenants,
    primaryTenantId: 'r',
    termMonths,
    bundleBps: 3000,
    rate: 3680,
    now: due,
  });

describe('quoteGroup', () => {
  it('restaurante + agenda Pro alineados: igual a la tabla validada', () => {
    const q = run([
      base({ tenantId: 'r', name: 'Rest' }),
      base({
        tenantId: 'a',
        name: 'Agenda',
        verticalCode: 'barber',
        priceUSD: 25,
      }),
    ]);
    expect(q.blocked).toBe(false);
    expect(q.lines.map((l) => [l.tenantId, l.amount])).toEqual([
      ['r', 121500],
      ['a', 64500],
    ]);
    expect(q.amount).toBe(186000);
    expect(q.listAmount).toBe(213500);
    expect(q.lines[1].discountReason).toContain('combo');
  });

  it('bloquea planes distintos y verticales repetidas', () => {
    const plans = run([
      base({ tenantId: 'r' }),
      base({ tenantId: 'a', verticalCode: 'barber', planCode: 'BASIC' }),
    ]);
    expect(plans.blocked).toBe(true);
    expect(plans.issues.map((i) => i.code)).toContain('plan_mismatch');

    const dup = run([base({ tenantId: 'r' }), base({ tenantId: 'r2' })]);
    expect(dup.issues.map((i) => i.code)).toContain('duplicate_vertical');
  });

  it('el negocio con precio fijado no entra al combo y se avisa', () => {
    const q = run([
      base({ tenantId: 'r' }),
      base({
        tenantId: 'a',
        verticalCode: 'barber',
        priceUSD: 25,
        lockedMonthlyCOP: 80000,
      }),
    ]);
    const agenda = q.lines.find((l) => l.tenantId === 'a')!;
    expect(agenda.amount).toBe(80000);
    expect(agenda.bundleBps).toBe(0);
    expect(q.issues.map((i) => i.code)).toContain('locked_price');
  });

  it('prorratea al que vence en otra fecha para alinearlo', () => {
    const q = run([
      base({ tenantId: 'r' }),
      base({
        tenantId: 'a',
        verticalCode: 'barber',
        priceUSD: 25,
        dueAt: new Date('2026-11-25T05:00:00Z'),
      }),
    ]);
    const agenda = q.lines.find((l) => l.tenantId === 'a')!;
    expect(agenda.factor).toBeLessThan(1);
    expect(agenda.amount).toBeLessThan(64500);
    expect(agenda.amount % 500).toBe(0);
    expect(agenda.periodEnd).toEqual(q.periodEnd);
    expect(q.issues.map((i) => i.code)).toContain('prorated');
  });

  it('quien ya está cubierto no paga en este periodo', () => {
    const q = run([
      base({ tenantId: 'r' }),
      base({
        tenantId: 'a',
        verticalCode: 'barber',
        priceUSD: 25,
        dueAt: new Date('2027-03-01T05:00:00Z'),
      }),
    ]);
    expect(q.lines.find((l) => l.tenantId === 'a')!.amount).toBe(0);
    expect(q.issues.map((i) => i.code)).toContain('already_covered');
  });

  it('anticipo de 12 meses encima del combo', () => {
    const q = run(
      [
        base({ tenantId: 'r', termBps: 1700 }),
        base({
          tenantId: 'a',
          verticalCode: 'barber',
          priceUSD: 25,
          termBps: 1700,
        }),
      ],
      12,
    );
    expect(q.amount).toBe(154500 * 12);
  });
});
