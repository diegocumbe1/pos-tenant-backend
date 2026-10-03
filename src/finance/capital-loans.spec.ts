import { CapitalMovement } from '@prisma/client';
import { loanLedger } from './capital.service';

let seq = 0;
const movement = (over: Partial<CapitalMovement>): CapitalMovement => ({
  id: `m${++seq}`,
  tenantId: 't',
  branchId: 'b',
  kind: 'CONTRIBUTION',
  amountCOP: 0,
  inKind: false,
  occurredAt: new Date('2026-09-01T17:00:00Z'),
  fundingSource: null,
  fundingNote: null,
  interestRateBps: null,
  interestPeriod: null,
  purpose: null,
  source: 'MANUAL',
  note: null,
  userId: null,
  createdAt: new Date(),
  updatedAt: new Date(),
  deletedAt: null,
  repaysMovementId: null,
  paidFromBusiness: null,
  ...over,
});

describe('loanLedger', () => {
  it('cada abono baja SU préstamo', () => {
    const paola = movement({
      fundingSource: 'FAMILY_LOAN',
      amountCOP: 939_000,
    });
    const alexandra = movement({
      fundingSource: 'PARTNER',
      amountCOP: 1_451_000,
    });
    const abono = movement({
      kind: 'LOAN_REPAYMENT',
      amountCOP: 300_000,
      repaysMovementId: paola.id,
      paidFromBusiness: true,
    });
    const ledger = loanLedger([paola, alexandra, abono]);
    expect(ledger.outstandingOf(paola)).toBe(639_000);
    expect(ledger.outstandingOf(alexandra)).toBe(1_451_000);
    expect(ledger.personalOutstandingCOP).toBe(2_090_000);
    expect(ledger.repaidFromBusinessCOP).toBe(300_000);
    // Lo prestado a nombre del dueño es deuda, no plata propia.
    expect(ledger.personalPrincipalCOP).toBe(2_390_000);
  });

  it('los ahorros no son deuda', () => {
    const ahorro = movement({ fundingSource: 'SAVINGS', amountCOP: 178_000 });
    expect(loanLedger([ahorro]).personalOutstandingCOP).toBe(0);
  });

  it('pagado del bolsillo baja la deuda pero no cuenta como plata del negocio', () => {
    const loan = movement({ kind: 'LOAN_IN', amountCOP: 1_000_000 });
    const abono = movement({
      kind: 'LOAN_REPAYMENT',
      amountCOP: 1_000_000,
      repaysMovementId: loan.id,
      paidFromBusiness: false,
    });
    const ledger = loanLedger([loan, abono]);
    expect(ledger.businessOutstandingCOP).toBe(0);
    expect(ledger.repaidFromBusinessCOP).toBe(0);
  });

  it('los abonos viejos sin préstamo asignado se aplican a los préstamos del negocio', () => {
    const loan = movement({ kind: 'LOAN_IN', amountCOP: 1_776_000 });
    const legacy = movement({ kind: 'LOAN_REPAYMENT', amountCOP: 500_000 });
    const ledger = loanLedger([loan, legacy]);
    expect(ledger.outstandingOf(loan)).toBe(1_276_000);
    expect(ledger.repaidFromBusinessCOP).toBe(500_000);
  });
});
