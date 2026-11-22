import {
  RECEIPT_TOKEN_RE,
  computeInstallment,
  newReceiptToken,
} from './payment-installments';

describe('computeInstallment', () => {
  it('anual Pro en 2 pagos: la primera cuota deja la mitad de saldo', () => {
    const r = computeInstallment({
      amount: 363000,
      number: 1,
      total: 2,
      planTotal: 726000,
      planListTotal: 876000,
      previousPaid: 0,
    });
    expect(r.balanceAfter).toBe(363000);
    expect(r.nextDueAmount).toBe(363000);
    expect(r.planListTotal - r.planTotal).toBe(150000);
  });

  it('la última cuota salda y no deja próxima cuota', () => {
    const r = computeInstallment({
      amount: 363000,
      number: 2,
      total: 2,
      planTotal: 726000,
      previousPaid: 363000,
    });
    expect(r.balanceAfter).toBe(0);
    expect(r.nextDueAmount).toBeNull();
  });

  it('con tres cuotas reparte parejo y la última lleva el residuo', () => {
    const first = computeInstallment({
      amount: 300000,
      number: 1,
      total: 3,
      planTotal: 1000000,
      previousPaid: 0,
    });
    expect(first.balanceAfter).toBe(700000);
    expect(first.nextDueAmount).toBe(350000);
    const second = computeInstallment({
      amount: 350000,
      number: 2,
      total: 3,
      planTotal: 1000000,
      previousPaid: 300000,
    });
    expect(second.nextDueAmount).toBe(350000);
  });

  it('rechaza sobrepago y cuota fuera de rango', () => {
    expect(() =>
      computeInstallment({
        amount: 400000,
        number: 2,
        total: 2,
        planTotal: 726000,
        previousPaid: 363000,
      }),
    ).toThrow();
    expect(() =>
      computeInstallment({
        amount: 1,
        number: 3,
        total: 2,
        planTotal: 10,
        previousPaid: 0,
      }),
    ).toThrow();
  });
});

describe('newReceiptToken', () => {
  it('cumple el formato público y no se repite', () => {
    const a = newReceiptToken();
    expect(RECEIPT_TOKEN_RE.test(a)).toBe(true);
    expect(newReceiptToken()).not.toBe(a);
  });
});
