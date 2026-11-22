import { renderComboDetail } from './services/subscription-context.service';
import { withComboDetail } from './services/message-sender.service';
import { TemplateRendererService } from './services/template-renderer.service';

const combo = {
  name: 'Combo',
  planLabel: 'Combo Pro',
  lines: [
    {
      tenantName: 'Ruta 43',
      verticalCode: 'restaurant',
      amount: 121500,
      listAmount: 121500,
      bundleBps: 0,
      position: 0,
      locked: false,
      covered: false,
    },
    {
      tenantName: 'Spa Luz',
      verticalCode: 'barber',
      amount: 64500,
      listAmount: 92000,
      bundleBps: 3000,
      position: 1,
      locked: false,
      covered: false,
    },
  ],
  amount: 186000,
  listAmount: 213500,
  discountAmount: 27500,
};

describe('detalle del combo en mensajes', () => {
  it('sin combo queda vacío', () => {
    expect(renderComboDetail(null)).toBe('');
  });

  it('con combo trae cada negocio, el descuento y el ahorro', () => {
    const text = renderComboDetail(combo);
    expect(text).toContain('*Combo Pro · 2 negocios*');
    expect(text).toMatch(/Ruta 43: \$\s?121\.500 \(precio completo\)/);
    expect(text).toMatch(
      /Spa Luz: \$\s?64\.500 \(−30% combo, antes \$\s?92\.000\)/,
    );
    expect(text).toMatch(/Ahorras \$\s?27\.500/);
    expect(text).not.toContain('~');
  });

  it('plantilla vieja: pega el detalle a la línea del valor solo si hay combo', () => {
    const body = 'Hola\n💵 Valor: *{{valor}}* · {{ciclo}}\nGracias';
    expect(withComboDetail(body, false)).toBe(body);
    expect(withComboDetail(body, true)).toBe(
      'Hola\n💵 Valor: *{{valor}}* · {{ciclo}}{{detalle_plan}}\nGracias',
    );
    const already = 'Valor {{valor}}{{detalle_plan}}';
    expect(withComboDetail(already, true)).toBe(already);
  });

  it('un negocio solo recibe exactamente el mismo texto que antes', () => {
    const renderer = new TemplateRendererService();
    const body = '💵 Valor: *{{valor}}* · {{ciclo}}{{detalle_plan}}\nFin';
    const out = renderer.render(body, {
      valor: '$ 92.000',
      ciclo: 'mensual',
      detalle_plan: '',
    });
    expect(out.text).toBe('💵 Valor: *$ 92.000* · mensual\nFin');
  });
});

import { renderReceiptDetail } from './services/subscription-context.service';
import { withReceiptDetail } from './services/message-sender.service';

describe('comprobante en "Pago recibido"', () => {
  const body = ['¡Gracias!', 'Pago de *{{valor}}*.{{detalle_plan}}', '', '{{firma}}'].join('\n');

  it('cuenta lo que entró y pega el detalle antes de la firma', () => {
    const out = withReceiptDetail(body, 'payment_received');
    expect(out).toContain('{{valor_pagado}}');
    expect(out).not.toContain('{{valor}}');
    expect(out.indexOf('{{detalle_comprobante}}')).toBeLessThan(out.indexOf('{{firma}}'));
  });

  it('no toca otras plantillas ni duplica la variable', () => {
    expect(withReceiptDetail(body, 'payment_reminder')).toBe(body);
    const once = withReceiptDetail(body, 'payment_received');
    expect(withReceiptDetail(once, 'payment_received')).toBe(once);
  });

  it('plan en cuotas: abono, saldo, próximo abono y enlace', () => {
    const text = renderReceiptDetail(
      {
        token: 'tok123',
        installment: {
          number: 1,
          total: 2,
          amount: 363000,
          balance: 363000,
          nextDueAt: new Date('2027-05-21T15:00:00Z'),
          nextDueAmount: 363000,
        },
      },
      'https://uselynko.com',
    );
    expect(text).toContain('Abono 1 de 2');
    expect(text).toContain('Saldo pendiente');
    expect(text).toContain('Próximo abono');
    expect(text).toContain('https://uselynko.com/comprobante/tok123');
  });

  it('pago sin comprobante: no deja renglones sueltos', () => {
    expect(renderReceiptDetail(null, 'https://uselynko.com')).toBe('');
  });
});
