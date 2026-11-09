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
