import {
  isSaleCaptureStart,
  matchProducts,
  parseDueDate,
  parseMethod,
  parseSaleMessage,
} from './retail-sale-capture';

const TODAY = '2026-11-04'; // miércoles
const parse = (message: string) => parseSaleMessage(message, TODAY);

describe('isSaleCaptureStart', () => {
  it.each([
    'vendí 2 mantequillas',
    'registrar venta',
    'registra una venta',
    'sepárale a Laura 1 perfume',
    'encargo de 5 mantequillas para Laura',
  ])('registra: "%s"', (text) => {
    expect(isSaleCaptureStart(text)).toBe(true);
  });

  it.each([
    '¿cuánto vendí hoy?',
    'cuanto vendi',
    'vendí mucho hoy',
    'ventas de ayer',
    'qué es lo que más vendo',
    'venta de ayer',
    'encargos pendientes',
  ])('es consulta: "%s"', (text) => {
    expect(isSaleCaptureStart(text)).toBe(false);
  });
});

describe('parseSaleMessage: las cuatro formas', () => {
  it('pagó y se lo llevó: el medio implica que pagó', () => {
    const sale = parse('vendí 2 mantequillas de coco a Laura por nequi');
    expect(sale).toMatchObject({
      lines: [{ text: 'mantequillas de coco', quantity: 2 }],
      customer: 'Laura',
      method: 'TRANSFER',
      paid: true,
    });
    expect(sale.delivered).toBeUndefined();
  });

  it('fiado', () => {
    expect(parse('vendí 1 perfume a Laura, queda debiendo')).toMatchObject({
      lines: [{ text: 'perfume', quantity: 1 }],
      customer: 'Laura',
      paid: false,
    });
  });

  it('fiado con abono: el medio es del abono, no un pago completo', () => {
    expect(
      parse('vendí 1 perfume a Laura, dejó 20 mil por nequi y queda debiendo'),
    ).toMatchObject({
      lines: [{ text: 'perfume', quantity: 1 }],
      customer: 'Laura',
      paid: false,
      depositCOP: 20_000,
      method: 'TRANSFER',
    });
  });

  it('separado', () => {
    expect(parse('sepárale a Laura 1 perfume')).toMatchObject({
      lines: [{ text: 'perfume', quantity: 1 }],
      customer: 'Laura',
      paid: false,
      delivered: false,
    });
  });

  it('encargo pagado', () => {
    expect(
      parse('encargo de 5 mantequillas de coco para Laura, ya pagó por nequi'),
    ).toMatchObject({
      lines: [{ text: 'mantequillas de coco', quantity: 5 }],
      customer: 'Laura',
      paid: true,
      delivered: false,
    });
  });

  it('se entrega luego, sin decir si pagó', () => {
    const sale = parse('vendí 2 perfumes a Laura, se lo llevo mañana');
    expect(sale.delivered).toBe(false);
    expect(sale.paid).toBeUndefined();
    expect(sale.deliveryNote).toBe('se lo llevo mañana');
  });

  it('"registrar venta" no asume nada', () => {
    const sale = parse('registrar venta');
    expect(sale.lines).toEqual([]);
    expect(sale.paid).toBeUndefined();
    expect(sale.delivered).toBeUndefined();
  });

  it('"vendí 2 mantequillas" deja la forma por preguntar', () => {
    const sale = parse('vendí 2 mantequillas');
    expect(sale.paid).toBeUndefined();
    expect(sale.lines).toEqual([{ text: 'mantequillas', quantity: 2 }]);
  });
});

describe('parseSaleMessage: lo demás', () => {
  it('toma la fecha de pago', () => {
    const sale = parse('vendí 1 perfume a Laura, paga el viernes');
    expect(sale.paid).toBe(false);
    expect(sale.dueOn).toBe('2026-11-06');
  });

  it('varios productos', () => {
    expect(parse('vendí 2 mantequillas y 1 perfume en efectivo').lines).toEqual(
      [
        { text: 'mantequillas', quantity: 2 },
        { text: 'perfume', quantity: 1 },
      ],
    );
  });

  it('"crema para manos" no es un cliente', () => {
    const sale = parse('vendí 1 crema para manos en efectivo');
    expect(sale.customer).toBeUndefined();
    expect(sale.lines[0].text).toBe('crema para manos');
  });

  it('precio dicho', () => {
    expect(parse('vendí 2 perfumes a 30 mil por nequi').price).toEqual({
      amountCOP: 30_000,
      per: 'unit',
    });
  });

  it('ayer y mayorista', () => {
    const sale = parse('vendí 12 perfumes al por mayor ayer en efectivo');
    expect(sale.daysAgo).toBe(1);
    expect(sale.wholesale).toBe(true);
    expect(sale.lines).toEqual([{ text: 'perfumes', quantity: 12 }]);
  });

  it.each([
    ['vendí 1 perfume financiado con addi', 'financing'],
    ['vendí 1 perfume, mitad en efectivo y mitad por nequi', 'split'],
    ['vendí 1 perfume en efectivo y por nequi', 'split'],
  ])('"%s" va al mostrador', (text, reason) => {
    expect(parse(text).needsMostrador).toBe(reason);
  });

  it('nequi en retail es transferencia', () => {
    expect(parseMethod('nequi')).toBe('TRANSFER');
    expect(parseMethod('por efectivo')).toBe('CASH');
    expect(parseMethod('bitcoin')).toBeNull();
  });
});

describe('parseDueDate', () => {
  it.each([
    ['hoy', '2026-11-04'],
    ['mañana', '2026-11-05'],
    ['pasado mañana', '2026-11-06'],
    ['el viernes', '2026-11-06'],
    ['miércoles', '2026-11-11'],
    ['el 15', '2026-11-15'],
    ['el 2', '2026-12-02'],
    ['15 de diciembre', '2026-12-15'],
    ['3 de enero', '2027-01-03'],
    ['la quincena', '2026-11-15'],
    ['la otra quincena', '2026-11-15'],
    ['fin de mes', '2026-11-30'],
  ])('"%s"', (text, day) => {
    expect(parseDueDate(text, TODAY)).toBe(day);
  });

  it.each(['no sabe', 'sin fecha', 'SIN FECHA'])(
    '"%s" es sin fecha',
    (text) => {
      expect(parseDueDate(text, TODAY)).toBe('none');
    },
  );

  it.each(['cuando le paguen', 'pronto', '31 de febrero', 'la otra semana'])(
    '"%s" no es una fecha',
    (text) => {
      expect(parseDueDate(text, TODAY)).toBeNull();
    },
  );

  it('el día 31 salta al mes que lo tenga o se rechaza', () => {
    expect(parseDueDate('el 31', '2026-11-04')).toBe('2026-12-31');
  });
});

describe('matchProducts', () => {
  const corporal = {
    name: 'Mantequilla Corporal',
    variants: [{ label: 'Coco' }, { label: 'Arrurú' }],
  };
  const manos = { name: 'Mantequilla de Manos', variants: [{ label: 'Rosa' }] };
  const perfume = { name: 'Perfume Azul', variants: [] };
  const all = [corporal, manos, perfume];

  it('singular, plural y lo que sobra', () => {
    const [match] = matchProducts('perfumes azul', all);
    expect(match.product).toBe(perfume);
    expect(match.leftover).toEqual([]);
  });

  it('empate: vuelven todos, no elige solo', () => {
    expect(matchProducts('mantequillas', all)).toHaveLength(2);
  });

  it('la opción desempata si solo un producto la tiene', () => {
    const matches = matchProducts('mantequillas de coco', all);
    expect(matches).toHaveLength(1);
    expect(matches[0].product).toBe(corporal);
    expect(matches[0].leftover).toEqual(['coco']);
  });

  it('lo que no existe no coincide con nada', () => {
    expect(matchProducts('zapatos', all)).toEqual([]);
  });
});
