import {
  WHATSAPP_TEMPLATE_DEFINITIONS,
  WHATSAPP_TEMPLATE_KEYS,
  renderWhatsappTemplate,
} from './message-templates';

describe('renderWhatsappTemplate', () => {
  it('sustituye los tokens con los valores dados', () => {
    const body = renderWhatsappTemplate('Hola {cliente}, pedido {pedido}', {
      '{cliente}': 'Ana',
      '{pedido}': '#12',
    });
    expect(body).toBe('Hola Ana, pedido #12');
  });

  it('descarta la línea cuyo único token viene vacío', () => {
    const body = renderWhatsappTemplate(
      ['Servicio: {servicio}', 'Especialista: {especialista}'].join('\n'),
      { '{servicio}': 'Corte', '{especialista}': undefined },
    );
    expect(body).toBe('Servicio: Corte');
  });

  it('conserva la línea si al menos un token tiene valor', () => {
    const body = renderWhatsappTemplate('Cliente: {cliente} ({telefono})', {
      '{cliente}': 'Ana',
      '{telefono}': '',
    });
    expect(body).toBe('Cliente: Ana ()');
  });

  it('trata los espacios en blanco como ausencia de valor', () => {
    const body = renderWhatsappTemplate(
      ['Total: {total}', 'Entrega: {entrega}'].join('\n'),
      { '{total}': '$ 10.000', '{entrega}': '   ' },
    );
    expect(body).toBe('Total: $ 10.000');
  });

  it('deja intactas las líneas sin tokens', () => {
    const body = renderWhatsappTemplate(
      ['Hola {cliente}:', '', 'Nos vemos pronto.'].join('\n'),
      { '{cliente}': 'Ana' },
    );
    expect(body).toBe('Hola Ana:\n\nNos vemos pronto.');
  });
});

describe('defaults de plantillas', () => {
  it.each(WHATSAPP_TEMPLATE_KEYS)(
    '%s declara todos los tokens que usa su texto',
    (key) => {
      const definition = WHATSAPP_TEMPLATE_DEFINITIONS[key];
      const used = definition.body.match(/\{[a-záéíóúñ_]+\}/gi) ?? [];
      for (const token of used) {
        expect(definition.variables).toContain(token);
      }
    },
  );

  it.each(WHATSAPP_TEMPLATE_KEYS)('%s cabe en su propio límite', (key) => {
    const definition = WHATSAPP_TEMPLATE_DEFINITIONS[key];
    expect(definition.body.length).toBeLessThanOrEqual(definition.limit);
  });

  it.each(WHATSAPP_TEMPLATE_KEYS)(
    '%s incluye en el texto los tokens que declara obligatorios',
    (key) => {
      const definition = WHATSAPP_TEMPLATE_DEFINITIONS[key];
      for (const token of definition.required) {
        expect(definition.body).toContain(token);
      }
    },
  );
});
