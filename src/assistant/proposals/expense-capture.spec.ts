import {
  isExpenseCaptureStart,
  matchAccount,
  parseAmount,
  parseExpenseMessage,
} from './expense-capture';
import { parseProposalCommand } from './proposal-commands';

describe('parseAmount', () => {
  it.each([
    ['50 mil', 50_000],
    ['50k', 50_000],
    ['50.000', 50_000],
    ['$50,000', 50_000],
    ['50000', 50_000],
    ['2 mil 500', 2_500],
    ['1 millón', 1_000_000],
    ['1.5 millones', 1_500_000],
    ['2 palos', 2_000_000],
  ])('entiende "%s"', (text, amountCOP) => {
    expect(parseAmount(text)).toEqual({ amountCOP, ambiguous: false });
  });

  it('un número pequeño a secas queda ambiguo: se pregunta', () => {
    expect(parseAmount('50')).toEqual({ amountCOP: 50, ambiguous: true });
  });

  it('prefiere el valor inequívoco sobre una cantidad', () => {
    expect(parseAmount('3 recibos por 50 mil')?.amountCOP).toBe(50_000);
  });

  it('no inventa un monto', () => {
    expect(parseAmount('domicilios')).toBeNull();
    expect(parseAmount('1,5')).toBeNull();
  });
});

describe('isExpenseCaptureStart', () => {
  it.each([
    'gasté 50 mil en domicilios',
    'Pagué la luz',
    'registrar gasto',
    'anota un gasto de 30 mil',
    'gasto de 20 mil en papelería',
  ])('registra: "%s"', (text) => {
    expect(isExpenseCaptureStart(text)).toBe(true);
  });

  it.each([
    '¿cuánto gasté este mes?',
    'cuánto gasté ayer',
    'gastos del mes',
    'gasto de ayer',
    'gasté mucho este mes',
    'en qué se me va la plata',
  ])('es consulta o comentario: "%s"', (text) => {
    expect(isExpenseCaptureStart(text)).toBe(false);
  });
});

describe('parseExpenseMessage', () => {
  it('saca monto, concepto y cuenta', () => {
    expect(
      parseExpenseMessage('gasté 50 mil en domicilios de efectivo'),
    ).toEqual({
      amount: { amountCOP: 50_000, ambiguous: false },
      concept: 'Domicilios',
      accountHint: 'efectivo',
      daysAgo: 0,
    });
  });

  it('entiende "ayer" sin dejarlo en el concepto', () => {
    const parsed = parseExpenseMessage('pagué 30 mil de luz ayer por nequi');
    expect(parsed.concept).toBe('Luz');
    expect(parsed.daysAgo).toBe(1);
    expect(parsed.accountHint).toBe('nequi');
  });

  it('deja sin llenar lo que no se dijo', () => {
    expect(parseExpenseMessage('registrar gasto')).toEqual({
      amount: null,
      concept: null,
      accountHint: null,
      daysAgo: 0,
    });
  });

  it('una cantidad en el concepto no se confunde con el monto', () => {
    const parsed = parseExpenseMessage('pagué 3 recibos por 50 mil');
    expect(parsed.amount?.amountCOP).toBe(50_000);
    expect(parsed.concept).toBe('3 recibos');
  });
});

describe('matchAccount', () => {
  const accounts = [
    { name: 'Caja', type: 'CASH', defaultForMethods: ['CASH'] },
    { name: 'Nequi Paola', type: 'WALLET', defaultForMethods: [] },
    { name: 'Nequi Tienda', type: 'WALLET', defaultForMethods: ['TRANSFER'] },
  ];

  it('resuelve por el medio de la cuenta', () => {
    expect(matchAccount('efectivo', accounts)?.name).toBe('Caja');
  });

  it('entre dos que coinciden no adivina', () => {
    expect(matchAccount('nequi', accounts)).toBeNull();
  });
});

describe('parseProposalCommand', () => {
  it('reconoce el código con cualquier escritura', () => {
    expect(parseProposalCommand('SI 4821')).toEqual({
      type: 'confirm',
      code: '4821',
    });
    expect(parseProposalCommand('sí 4821.')).toEqual({
      type: 'confirm',
      code: '4821',
    });
    expect(parseProposalCommand('no 4821')).toEqual({
      type: 'reject',
      code: '4821',
    });
    expect(parseProposalCommand('¿qué es 4821?')).toEqual({
      type: 'inspect',
      code: '4821',
    });
  });

  it('un sí dentro de una frase o en una ráfaga no confirma nada', () => {
    expect(parseProposalCommand('si 4821 y otro más')).toBeNull();
    expect(parseProposalCommand('SI 4821\nNO')).toBeNull();
    expect(parseProposalCommand('si 482')).toBeNull();
  });

  it('un sí sin código no lleva código', () => {
    expect(parseProposalCommand('sí')).toEqual({ type: 'bare_yes' });
  });
});
